function errorMessage(error) {
  if (!error) return "Unknown Widevine component error";
  return error instanceof Error ? error.message : String(error);
}

export async function initializeWidevineRuntime(componentsApi, report = () => {}) {
  if (!componentsApi?.whenReady) {
    const result = { ready: false, reason: "components-api-unavailable" };
    report(result);
    return result;
  }

  try {
    componentsApi.updatesEnabled = true;
    const required = componentsApi.WIDEVINE_CDM_ID
      ? [componentsApi.WIDEVINE_CDM_ID]
      : undefined;
    const installed = await componentsApi.whenReady(required);
    const result = {
      ready: true,
      components: installed,
      status: componentsApi.status?.() || {}
    };
    report(result);
    return result;
  } catch (error) {
    const result = {
      ready: false,
      reason: "component-install-failed",
      error: errorMessage(error),
      componentErrors: Array.isArray(error?.errors)
        ? error.errors.map((componentError) => errorMessage(componentError))
        : []
    };
    report(result);
    return result;
  }
}
