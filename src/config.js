const integer = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
};

const optional = (value) => value?.trim() || undefined;

export function loadConfig(env = process.env) {
  return Object.freeze({
    uiPort: integer(env.UI_PORT, 8080),
    mediaPort: integer(env.MEDIA_PORT, 5050),
    storagePath: optional(env.RUN_STORAGE_PATH) ?? '/data/runs',
    maxCallSeconds: integer(env.MAX_CALL_SECONDS, 600),
    openaiModel: optional(env.OPENAI_REALTIME_MODEL) ?? 'gpt-realtime-2.1-mini',
    openaiApiKey: optional(env.OPENAI_API_KEY),
    twilioAccountSid: optional(env.TWILIO_ACCOUNT_SID),
    twilioAuthToken: optional(env.TWILIO_AUTH_TOKEN),
    twilioFromNumber: optional(env.TWILIO_FROM_NUMBER),
    publicMediaUrl: optional(env.PUBLIC_MEDIA_URL),
  });
}
