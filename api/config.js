// Tells the browser which features are available on this deployment.
import { json, isMock } from "./_lib/http.js";
import { canTranscribe } from "./transcribe.js";
import { writingProvider } from "./_lib/writer.js";
import { canPublish } from "./_lib/books.js";

export function GET() {
  return json({
    accessCodeRequired: Boolean(process.env.ACCESS_CODE),
    transcription: isMock() || canTranscribe(),
    writing: isMock() || Boolean(writingProvider()),
    publishing: canPublish(),
    mock: isMock(),
  });
}
