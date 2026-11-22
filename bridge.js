'use strict';

const { once } = require('node:events');
const path = require('node:path');
const { GameBridge } = require('./game');
const { openEditor, deliver } = require('./editor');

async function main() {
    const arg = process.argv[2] || '19135';
    const port = Number(arg);
    if (!/^\d+$/.test(arg) || port < 1024 || port > 65535) {
        throw new Error('ポート番号には 1024～65535 を指定してください。例: Start.cmd 19136');
    }
    const profile = process.env.MAKECODE_BRIDGE_PROFILE
        || path.join(process.env.LOCALAPPDATA, 'MakeCodeBedrockBridge', 'Edge');
    let page;
    let context;
    const game = new GameBridge(port, message => {
        deliver(page, message).catch(error => {
            if (page && !page.isClosed()) console.warn(`[MakeCode] ${error.message}`);
        });
    });
    let stopping = false;
    async function stop() {
        if (stopping) return;
        stopping = true;
        for (const socket of game.server.clients) socket.terminate();
        game.server.close();
        await context?.close();
    }
    try {
        await once(game.server, 'listening');
        game.server.on('error', error => console.error(`[Minecraft] ${error.message}`));
        process.once('SIGINT', stop);
        console.log('MakeCode Bedrock Bridge');
        console.log(`チートを有効にしたワールドのチャットに入力: /connect 127.0.0.1:${port}`);
        console.log('Edge で MakeCode を開いています。このウィンドウは開いたままにしてください。');
        ({ context, page } = await openEditor(profile, message => game.request(message)));
        const closed = once(page, 'close');
        await closed;
    } catch (error) {
        if (error.code === 'EADDRINUSE') {
            throw new Error(`ポート ${port} は使用中です。旧 CodeConnectFix を終了するか Start.cmd 19136 を実行してください。`);
        }
        throw error;
    } finally {
        await stop();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
