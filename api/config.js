// Tells the browser which features are available on this deployment.
import { json, isMock } from "./_lib/http.js";

export function GET() {
  return json({
    accessCodeRequired: Boolean(process.env.ACCESS_CODE),
    transcription: isMock() || Boolean(process.env.OPENAI_API_KEY),
    writing: isMock() || Boolean(process.env.ANTHROPIC_API_KEY),
    mock: isMock(),
  });
}
