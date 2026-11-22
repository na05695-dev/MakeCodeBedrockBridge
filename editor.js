'use strict';

const { chromium } = require('playwright-core');

const EDITOR = 'https://minecraft.makecode.com';
const SIMULATOR = 'https://trg-minecraft.userpxt.io';

async function openEditor(profile, onRequest) {
    const context = await chromium.launchPersistentContext(profile, {
        channel: 'msedge',
        headless: false,
        chromiumSandbox: true,
        viewport: null,
        args: ['--lang=ja-JP']
    });
    try {
        const page = context.pages()[0] ?? await context.newPage();
        const canReachGame = ({ frame }) => frame === page.mainFrame()
            && new URL(frame.url()).origin === EDITOR;

        await context.exposeBinding('bedrockBridgeRequest', (source, frame) => {
            if (canReachGame(source)) onRequest(frame);
        });
        await context.addInitScript(({ editor, simulator }) => {
            if (location.origin !== editor || window !== window.top) return;

            // MakeCode uses this small portion of Code Connection's IPC interface.
            let onResponse;
            window.ipcRenderer = Object.freeze({
                on(channel, listener) {
                    if (channel === 'responseFromApp') onResponse = listener;
                },
                sendToHost(channel, message) {
                    if (channel === 'sendToApp') {
                        window.bedrockBridgeRequest(message).catch(console.error);
                    }
                }
            });
            window.addEventListener('message', event => {
                if (event.data?.__proxy !== 'parent') return;
                const isSimulator = event.origin === simulator
                    && Array.from(document.querySelectorAll('iframe')).some(
                        iframe => iframe.contentWindow === event.source
                    );
                if (!isSimulator) event.stopImmediatePropagation();
            }, true);
            window.bedrockBridgeResponse = message => {
                onResponse?.(null, JSON.stringify(message));
            };
        }, { editor: EDITOR, simulator: SIMULATOR });

        await page.goto(EDITOR + '/?ipc=1&lang=ja', { waitUntil: 'domcontentloaded', timeout: 60000 });
        return { context, page };
    } catch (error) {
        await context.close();
        throw error;
    }
}

async function deliver(page, frame) {
    if (!page || page.isClosed() || new URL(page.url()).origin !== EDITOR) return;
    await page.evaluate(message => window.bedrockBridgeResponse?.(message), frame);
}

module.exports = { openEditor, deliver };
