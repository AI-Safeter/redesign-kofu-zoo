// Tells the browser which features are available on this deployment.
import { json, isMock } from "./_lib/http.js";
import { transcriptionProvider } from "./transcribe.js";
import { writingProvider } from "./_lib/writer.js";

export function GET() {
  return json({
    accessCodeRequired: Boolean(process.env.ACCESS_CODE),
    transcription: isMock() || Boolean(transcriptionProvider()),
    writing: isMock() || Boolean(writingProvider()),
    mock: isMock(),
  });
}
