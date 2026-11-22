'use strict';

const {
    createCipheriv, createDecipheriv, createHash, createPublicKey,
    diffieHellman, generateKeyPairSync, randomBytes, randomUUID
} = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');

const ENCRYPTION_PROTOCOL = 'com.microsoft.minecraft.wsencrypt';
const MAKECODE_VERSION = 16842752;
const INITIATED = 131075;
const nilId = '00000000-0000-0000-0000-000000000000';

function frame(purpose, requestId, body, version = 1) {
    return { header: { messagePurpose: purpose, messageType: 'commandRequest', requestId, version }, body };
}

function beginEncryption() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const salt = randomBytes(16);
    return {
        command: `enableencryption "${key}" "${salt.toString('base64')}"`,
        finish(clientKey) {
            const client = createPublicKey({
                key: Buffer.from(clientKey, 'base64'), type: 'spki', format: 'der'
            });
            const secret = diffieHellman({ privateKey, publicKey: client });
            const cipherKey = createHash('sha256').update(salt).update(secret).digest();
            const iv = cipherKey.subarray(0, 16);
            return {
                outgoing: createCipheriv('aes-256-cfb8', cipherKey, iv),
                incoming: createDecipheriv('aes-256-cfb8', cipherKey, iv)
            };
        }
    };
}

function send(socket, message, encryption) {
    const json = JSON.stringify(message);
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(encryption ? encryption.outgoing.update(json, 'utf8') : json);
    }
}

function commandBody(commandLine, purpose) {
    const body = { commandLine, version: 1 };
    if (purpose === 'commandRequest') body.origin = { type: 'player' };
    return body;
}

function makeEvent(message) {
    const { header, body } = message;
    const eventName = header.eventName ?? body.eventName;
    if (typeof eventName !== 'string') return;
    let payload = body;
    const props = body.properties;
    if (props && typeof props === 'object') {
        if (eventName === 'PlayerMessage') {
            payload = {
                type: props.MessageType, message: props.Message,
                sender: props.Sender, receiver: props.Receiver
            };
        } else if (eventName === 'PlayerTravelled') {
            payload = { travelMethod: props.TravelMethodType };
        } else if (eventName === 'BlockPlaced' || eventName === 'BlockBroken') {
            payload = { block: { id: props.Type, aux: props.AuxType ?? 0 } };
        } else if (eventName === 'AgentCommand') {
            return { header: { ...header, messagePurpose: 'action:agent' }, body: props };
        } else {
            return;
        }
    }
    return { header: { ...header, eventName, messagePurpose: 'event' }, body: payload };
}

class GameBridge {
    constructor(port, onResponse, log = console.log) {
        this.onResponse = onResponse;
        this.log = log;
        this.session = null;
        this.server = new WebSocketServer({
            host: '127.0.0.1',
            port,
            maxPayload: 4 * 1024 * 1024,
            perMessageDeflate: false,
            // Native Bedrock does not send an Origin. Reject browser handshakes.
            verifyClient: ({ origin }) => origin === undefined,
            handleProtocols: protocols => protocols.has(ENCRYPTION_PROTOCOL) ? ENCRYPTION_PROTOCOL : false
        });
        this.server.on('connection', socket => this.connect(socket));
    }

    connect(socket) {
        if (this.session) {
            socket.close(1008, 'A Minecraft world is already connected');
            return;
        }
        const session = {
            socket, ready: false, encryption: null, handshake: null,
            pending: new Map(), subscriptions: new Set()
        };
        this.session = session;
        socket.on('error', error => this.log(`[Minecraft] ${error.message}`));
        socket.on('close', code => {
            clearTimeout(session.handshake?.timer);
            if (this.session === session) this.session = null;
            const pending = new Set(session.pending.values());
            for (const request of pending) {
                clearTimeout(request.timer);
                this.error(request.id, 'Minecraft との接続が切れました。', request.acknowledged);
            }
            this.log(`[Minecraft] 切断 (${code})。ワールド内で /connect をやり直してください。`);
        });
        socket.on('message', data => {
            try {
                const json = session.encryption ? session.encryption.incoming.update(data) : data;
                this.receive(session, JSON.parse(json.toString('utf8')));
            } catch (error) {
                this.log(`[Minecraft] 応答を読み取れませんでした。 ${error.message}`);
                socket.close(1002, 'Invalid Minecraft response');
            }
        });

        if (socket.protocol !== ENCRYPTION_PROTOCOL) {
            this.ready(session);
            return;
        }
        const exchange = beginEncryption();
        const id = randomUUID();
        const timer = setTimeout(() => {
            this.log('[Minecraft] 暗号化の応答がタイムアウトしました。');
            socket.close(1002, 'Encryption handshake timed out');
        }, 7000);
        session.handshake = { id, timer, finish: exchange.finish };
        send(socket, frame('commandRequest', id, commandBody(exchange.command, 'commandRequest')));
    }

    ready(session) {
        session.ready = true;
        const encryption = session.encryption ? '暗号化あり' : '暗号化なし';
        this.log(`[Minecraft] 接続済み（${encryption}）。MakeCode の ▶ で実行できます。`);
    }

    error(id, statusMessage, agentAcknowledged = false) {
        const purpose = agentAcknowledged ? 'action:agent' : 'error';
        this.onResponse(frame(purpose, id, { statusCode: -1, statusMessage }, MAKECODE_VERSION));
    }

    request(message) {
        const { header, body } = message ?? {};
        if (!header || !body || typeof header.requestId !== 'string') return;
        const { messagePurpose: purpose, requestId: id } = header;
        if (purpose === 'data:telemetry') return;
        const cmd = body.commandLine?.trim?.() ?? body.name;
        const session = this.session;
        if (!session?.ready) {
            if (purpose !== 'subscribe' && purpose !== 'unsubscribe') {
                this.error(id, 'Minecraft に接続してから ▶ を押してください。');
            }
            return;
        }
        if (cmd === 'geteduclientinfo' && purpose === 'commandRequest') {
            // Select the modern MakeCode message shape without misreporting the game edition.
            if (id === '0') {
                for (const pending of session.pending.values()) clearTimeout(pending.timer);
                session.pending.clear();
            }
            this.onResponse(frame('commandResponse', id, {
                statusCode: 0, companionProtocolVersion: 4, isEdu: false
            }, MAKECODE_VERSION));
            return;
        }
        if (purpose === 'subscribe' || purpose === 'unsubscribe') {
            const name = body.eventName;
            if (typeof name !== 'string' || !/^[a-zA-Z0-9:_.-]{1,80}$/.test(name)) return;
            if (session.subscriptions.has(name) === (purpose === 'subscribe')) return;
            if (purpose === 'subscribe') session.subscriptions.add(name);
            else session.subscriptions.delete(name);
            send(session.socket, frame(purpose, nilId, { eventName: name }), session.encryption);
            return;
        }
        if ((purpose !== 'commandRequest' && purpose !== 'action:agent') || typeof cmd !== 'string' || !cmd) {
            this.error(id, 'この MakeCode リクエストは現在のブリッジでは扱えません。');
            return;
        }
        this.sendCommand(session, { id, purpose, cmd });
    }

    sendCommand(session, request) {
        const { id, purpose, cmd } = request;
        const wireId = randomUUID();
        const pending = { ...request };
        pending.timer = setTimeout(() => {
            session.pending.delete(wireId);
            this.error(id, 'Minecraft からのコマンド応答がタイムアウトしました。', pending.acknowledged);
        }, 10000);
        session.pending.set(wireId, pending);
        send(session.socket, frame(purpose, wireId, commandBody(cmd, purpose)), session.encryption);
    }

    receive(session, message) {
        const { header, body } = message ?? {};
        if (!header || !body) return;
        const { requestId: wireId, messagePurpose: purpose } = header;
        if (session.handshake) {
            if (wireId !== session.handshake.id || body.statusCode === INITIATED) return;
            clearTimeout(session.handshake.timer);
            if (typeof body.publicKey !== 'string') {
                this.log('[Minecraft] 暗号化のハンドシェイクが拒否されました。');
                session.socket.close(1002, 'Encryption handshake failed');
                return;
            }
            session.encryption = session.handshake.finish(body.publicKey);
            session.handshake = null;
            this.ready(session);
            return;
        }
        if (purpose === 'event' || purpose === 'chat') {
            const event = makeEvent(message);
            if (event) this.onResponse(event);
            return;
        }
        if (!['commandResponse', 'error', 'action:agent'].includes(purpose)) return;
        const request = session.pending.get(wireId);
        if (!request) return;
        const response = { header: { ...header, requestId: request.id }, body };
        if (purpose === 'action:agent') {
            // MakeCode expects an acknowledgment before the asynchronous agent result.
            if (!request.acknowledged) {
                this.onResponse(frame('commandResponse', request.id, { statusCode: 0 }, MAKECODE_VERSION));
            }
            this.onResponse(response);
        } else if (request.cmd === 'getlocalplayername' && body.statusCode < 0) {
            clearTimeout(request.timer);
            session.pending.delete(wireId);
            this.sendCommand(session, { id: request.id, purpose: request.purpose, cmd: 'testfor @s' });
            return;
        } else {
            if (request.cmd === 'testfor @s' && Array.isArray(body.victim)) {
                response.body = { ...body, localplayername: body.victim[0] };
            }
            this.onResponse(response);
            if (body.statusCode === INITIATED) return;
            if (request.purpose === 'action:agent' && body.statusCode === 0) {
                request.acknowledged = true;
                return;
            }
        }
        clearTimeout(request.timer);
        session.pending.delete(wireId);
    }
}

module.exports = { GameBridge };
