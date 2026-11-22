'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { createECDH, createCipheriv, createDecipheriv, createHash } = require('node:crypto');
const { WebSocket } = require('ws');
const { GameBridge } = require('../game');

const encryptionProtocol = 'com.microsoft.minecraft.wsencrypt';

async function fixture(t, protocol, options) {
    const responses = [];
    const logs = [];
    const bridge = new GameBridge(0, response => responses.push(response), line => logs.push(line));
    await once(bridge.server, 'listening');
    const client = new WebSocket(`ws://127.0.0.1:${bridge.server.address().port}`, protocol, options);
    t.after(() => {
        client.terminate();
        return new Promise(resolve => bridge.server.close(resolve));
    });
    return { bridge, client, responses, logs };
}

function editorCommand(bridge, requestId, commandLine) {
    bridge.request({ header: { messagePurpose: 'commandRequest', requestId }, body: { commandLine } });
}

function reply(request, body, purpose = 'commandResponse') {
    return JSON.stringify({ header: { ...request.header, messagePurpose: purpose }, body });
}

async function checkpoint(check) {
    for (let attempt = 0; attempt < 80; attempt++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Bridge response did not arrive');
}

test('negotiates MakeCode, forwards commands in order, and returns chat events', { timeout: 5000 }, async t => {
    const { bridge, client, responses } = await fixture(t);
    await once(client, 'open');
    bridge.request({ header: { messagePurpose: 'commandRequest', requestId: '0' }, body: { name: 'geteduclientinfo' } });
    assert.equal(responses[0].header.version, 16842752);
    assert.equal(responses[0].body.isEdu, false);

    for (const [index, command] of ['say MakeCode', 'setblock ~ ~ ~1 gold_block'].entries()) {
        const next = once(client, 'message');
        const id = String(index + 1);
        editorCommand(bridge, id, command);
        const request = JSON.parse((await next)[0]);
        assert.equal(request.body.commandLine, command);
        assert.match(request.header.requestId, /^[0-9a-f-]{36}$/);
        client.send(reply(request, { statusCode: 131075 }));
        client.send(reply(request, { statusCode: 0 }));
        await checkpoint(() => responses.some(
            x => x.header.requestId === id && x.body.statusCode === 0));
    }
    const subscribed = once(client, 'message');
    bridge.request({
        header: { messagePurpose: 'subscribe', requestId: '3' },
        body: { eventName: 'PlayerMessage' }
    });
    assert.equal(JSON.parse((await subscribed)[0]).body.eventName, 'PlayerMessage');
    client.send(JSON.stringify({
        header: { version: 1, messagePurpose: 'event' },
        body: { eventName: 'PlayerMessage', properties: { MessageType: 'chat', Message: 'hello', Sender: 'Test' } }
    }));
    await checkpoint(() => responses.at(-1)?.header.eventName === 'PlayerMessage');
    assert.equal(responses.at(-1).body.message, 'hello');
});

test('negotiates Bedrock encryption and relays encrypted command responses', { timeout: 5000 }, async t => {
    const { bridge, client, responses, logs } = await fixture(t, encryptionProtocol);
    const request = JSON.parse((await once(client, 'message'))[0]);
    assert.equal(client.protocol, encryptionProtocol);
    const [, publicKey, salt] = /^enableencryption "([^"]+)" "([^"]+)"$/.exec(request.body.commandLine);
    const serverKey = Buffer.from(publicKey, 'base64');
    const clientKey = createECDH('secp384r1');
    const point = clientKey.generateKeys();
    const headerLength = serverKey.length - point.length;
    const key = createHash('sha256').update(Buffer.from(salt, 'base64'))
        .update(clientKey.computeSecret(serverKey.subarray(headerLength))).digest();
    const decipher = createDecipheriv('aes-256-cfb8', key, key.subarray(0, 16));
    const cipher = createCipheriv('aes-256-cfb8', key, key.subarray(0, 16));
    const der = Buffer.concat([serverKey.subarray(0, headerLength), point]);
    client.send(reply(request, { statusCode: 0, publicKey: der.toString('base64') }));
    await checkpoint(() => logs.some(line => line.includes('暗号化あり')));

    const next = once(client, 'message');
    editorCommand(bridge, '1', 'say 暗号化テスト');
    const [data, binary] = await next;
    assert.equal(binary, true);
    const incoming = JSON.parse(decipher.update(data));
    assert.equal(incoming.body.commandLine, 'say 暗号化テスト');
    client.send(cipher.update(reply(incoming, { statusCode: 0 })));
    await checkpoint(() => responses.length === 1);
    assert.equal(responses[0].header.requestId, '1');
    assert.equal(responses[0].body.statusCode, 0);
});

test('rejects website-origin connections on the game port', { timeout: 5000 }, async t => {
    const { client } = await fixture(t, undefined, { origin: 'https://example.com' });
    const [error] = await once(client, 'error');
    assert.match(error.message, /401/);
});
