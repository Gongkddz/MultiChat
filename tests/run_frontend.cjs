// Run after starting tests/preview_ui.py. Dependencies stay in tests/frontend/node_modules.
const { JSDOM, VirtualConsole } = require('./frontend/node_modules/jsdom');
(async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
        try { const response = await fetch('http://127.0.0.1:18765/'); await response.arrayBuffer(); if (response.ok) break; }
        catch (_) { if (attempt === 49) throw new Error('Preview server did not start'); }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    const console = new VirtualConsole();
    console.on('jsdomError', error => process.stderr.write(error.message + '\n'));
    const dom = await JSDOM.fromURL('http://127.0.0.1:18765/', {
        resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true,
        virtualConsole: console,
        beforeParse(window) {
            Object.assign(window, { TextEncoder, TextDecoder, Response, ReadableStream });
            window.matchMedia = () => ({ matches: false });
        },
    });
    const started = Date.now();
    while (!dom.window.document.body?.dataset.qa && Date.now() - started < 10000) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    const status = dom.window.document.body?.dataset.qa;
    process.stdout.write((dom.window.document.querySelector('#qa-results')?.textContent || 'UI test timed out') + '\n');
    dom.window.close();
    process.exitCode = status === 'passed' ? 0 : 1;
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
