async page => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const origin = new URL(page.url()).origin, errors = [];
  const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 900 } });
  const target = await context.newPage();
  target.on('pageerror', error => errors.push(error.message));
  await target.addInitScript(() => {
    window.usb = { writes: [], times: [], block: false, release: null };
    window.pad = { index: 0, id: 'Synthetic gamepad', connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) };
    Object.defineProperty(navigator, 'getGamepads', { value: () => [window.pad] });
    Object.defineProperty(navigator, 'serial', { value: { requestPort: async () => ({
      open: async () => {}, close: async () => {},
      readable: new ReadableStream({ start(controller) { window.usb.incoming = controller; } }),
      writable: { getWriter: () => ({
        write: async bytes => {
          window.usb.writes.push(new TextDecoder().decode(bytes));
          window.usb.times.push(performance.now());
          if (window.usb.block) await new Promise(resolve => { window.usb.release = resolve; });
        }, releaseLock() {},
      }) },
    }) } });
    window.Hands = class {
      setOptions() {} onResults(callback) { this.callback = callback; }
      async send() { this.callback({ multiHandLandmarks: [] }); }
      async close() {}
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 400;
      const ctx = canvas.getContext('2d'), stream = canvas.captureStream(15);
      window.cameraInterval = setInterval(() => ctx.fillRect(0, 0, 640, 400), 60);
      return stream;
    } });
  });
  const ready = async () => {
    await target.locator('#viewport[data-ready="true"]').waitFor();
    await target.waitForFunction(() => !document.getElementById('start-control').disabled);
  };
  const pose = () => target.locator('.angle-field input').evaluateAll(inputs => inputs.map(input => Number(input.value)));
  const writes = () => target.evaluate(() => [...window.usb.writes]);
  const angle = async (name, value) => {
    const input = target.getByRole('spinbutton', { name: `${name} angle`, exact: true });
    await input.fill(String(value)); await input.press('Tab');
  };
  try {
    await target.goto(origin); await ready();
    check(await target.locator('#home-arm').count() === 0, 'No homing action remains.');
    check(await target.locator('#record').isDisabled(), 'Recording waits for Start.');
    await target.screenshot({ path: 'output/playwright/alignment-desktop.png' });
    await target.locator('#toggle-inputs').click();
    await target.locator('#connect-serial').click();
    await target.getByRole('button', { name: 'Disconnect Arduino', exact: true }).waitFor();
    check(await target.getByRole('slider', { name: 'Shoulder position' }).getAttribute('max') === '90', 'Shoulder slider exposes all 180 degrees.');
    await angle('Shoulder', 90);
    check((await pose())[1] === 90 && (await writes()).length === 0, 'Alignment reaches +90 degrees without USB movement.');
    for (const [name, value] of [['Turntable', 25], ['Shoulder', -30], ['Elbow', 40], ['Claw', -20]]) await angle(name, value);
    const aligned = await pose();
    check(JSON.stringify(aligned) === JSON.stringify([25, -30, 40, -20]), 'Setup directly positions the model.');
    await target.evaluate(() => window.usb.incoming.enqueue(new TextEncoder().encode('P0:0,P1:0,P2:0,P3:0\n')));
    await target.locator('#toggle-camera').click();
    await target.getByRole('button', { name: 'Disable camera', exact: true }).waitFor();
    check(await target.locator('#hand-control').isDisabled() && !await target.locator('#hand-control').isChecked(), 'Camera preview cannot arm movement in setup.');
    await target.waitForTimeout(250);
    check(JSON.stringify(await pose()) === JSON.stringify(aligned), 'Incoming USB/camera input cannot replace the aligned pose.');
    check((await writes()).length === 0, 'Setup sends zero movement commands.');

    // A held controller cannot move the mechanism as soon as Start is clicked.
    await target.evaluate(() => { window.pad.axes[2] = 1; document.getElementById('start-control').click(); });
    await target.waitForTimeout(250);
    check((await writes()).length === 0, 'Start itself and a held stick send nothing.');
    check(JSON.stringify(await pose()) === JSON.stringify(aligned), 'Start retains the aligned pose.');
    await target.evaluate(() => { window.pad.axes[2] = 0; });
    await target.waitForTimeout(100);
    await angle('Claw', 40);
    await target.waitForFunction(() => Number(document.querySelectorAll('.angle-field input')[3].value) === 40);
    await target.waitForFunction(() => window.usb.writes.at(-1)?.includes('S3:150'));
    const sent = await writes();
    check(sent.length > 0, 'Fresh control input sends commands.');
    check(sent.every(text => /^S0:103,S1:120,S2:130,S3:\d+\n$/.test(text)), 'Only claw changes; the first packet retains the aligned other joints and original protocol.');
    check(sent.at(-1).includes('S3:150'), 'Claw reaches the requested position.');

    // Exercise actual slider-to-USB output on both sides of the reported band.
    for (const degrees of [-15, -25, 15, 25]) {
      await angle('Shoulder', degrees);
      await target.waitForFunction(value => Number(document.querySelectorAll('.angle-field input')[1].value) === value && window.usb.writes.at(-1)?.includes(`S1:${Math.round(90 - value)},`), degrees);
      check((await pose())[1] === degrees, 'The displayed shoulder keeps moving outside ±20 degrees.');
    }
    check(await target.evaluate(() => window.usb.times.some((time, index, times) => index > 0 && time - times[index - 1] < 45)), 'Shoulder USB output uses the faster clock instead of the old 50 ms cap.');

    // Re-alignment waits for an accepted write, then drops any old destination.
    await target.evaluate(() => { window.usb.block = true; });
    await angle('Shoulder', 0);
    await target.waitForFunction(() => !!window.usb.release);
    await target.locator('#align-model').click();
    check(await target.locator('#start-control').isDisabled(), 'An in-flight write blocks Start.');
    check(await target.getByRole('spinbutton', { name: 'Shoulder angle' }).isDisabled(), 'Wait for USB before editing the reference.');
    await target.evaluate(() => { window.usb.block = false; window.usb.release(); });
    await ready();
    const count = (await writes()).length;
    await angle('Shoulder', -50); await angle('Claw', 10);
    await target.locator('#start-control').click();
    await target.waitForTimeout(250);
    check((await writes()).length === count, 'Restart sends nothing and discards shoulder catch-up.');

    // Gamepad A now enters alignment and never sends a zero-position packet.
    await target.evaluate(() => { window.pad.buttons[0].pressed = true; });
    await target.locator('#start-control').waitFor();
    check((await pose())[1] === -50, 'Controller A preserves the pose.');
    await target.evaluate(() => { window.pad.buttons[0].pressed = false; });
    await target.locator('#start-control').click();
    await target.locator('#toggle-camera').click();
    await target.locator('#connect-serial').click();
    await target.getByRole('button', { name: 'Connect Arduino', exact: true }).waitFor();
    await target.locator('#start-control').click();
    await target.locator('#connect-serial').click();
    await target.getByRole('button', { name: 'Disconnect Arduino', exact: true }).waitFor();
    check(await target.locator('#start-control').isVisible(), 'Reconnecting always returns to alignment.');
    check((await writes()).length === count, 'Disconnect/reconnect sends no position command.');

    await target.setViewportSize({ width: 390, height: 844 });
    await target.waitForTimeout(150);
    check(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Setup fits a narrow screen.');
    const boxes = await Promise.all(['#toggle-joints', '#start-control', '#stop-motion', '#toggle-inputs'].map(id => target.locator(id).boundingBox()));
    check(boxes.every(box => box && box.x >= 0 && box.x + box.width <= 390), 'Top controls stay on screen.');
    for (let i = 1; i < boxes.length; i++) check(boxes[i].x >= boxes[i - 1].x + boxes[i - 1].width, 'Top controls do not overlap.');
    await target.screenshot({ path: 'output/playwright/alignment-mobile.png' });
    await target.reload(); await ready();
    check(await target.locator('#start-control').isVisible(), 'Reload requires alignment again.');
    check(errors.length === 0, errors.join('; '));
    return 'PASS: model-only alignment, zero USB output on Start, original wire format, aligned reference, camera/echo isolation, held gamepad, in-flight write, gamepad A, reconnect, reload, desktop/mobile layout.';
  } finally {
    await target.evaluate(() => { clearInterval(window.cameraInterval); window.usb.release?.(); }).catch(() => {});
    await context.close();
  }
}
