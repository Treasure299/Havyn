const { app, components } = require("electron");

async function run() {
  try {
    await app.whenReady();
    components.updatesEnabled = true;
    await components.whenReady([components.WIDEVINE_CDM_ID]);
    const status = components.status();
    const widevine = status[components.WIDEVINE_CDM_ID];

    if (!widevine) {
      throw new Error("Widevine CDM was not reported after component installation");
    }

    console.log(JSON.stringify({ ready: true, widevine }));
    app.exit(0);
  } catch (error) {
    console.error(error?.stack || error);
    app.exit(1);
  }
}

run();
