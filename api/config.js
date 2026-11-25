// Tells the browser which features are available on this deployment.
import { checkAccess, json, isMock } from "./_lib/http.js";
import { canTranscribe } from "./transcribe.js";
import { canWrite } from "./_lib/writer.js";
import { canPublish } from "./_lib/books.js";

export function GET(request) {
  return json({
    accessCodeRequired: Boolean(process.env.ACCESS_CODE),
    accessOk: !checkAccess(request), // whether the x-access-code header sent is right
    transcription: isMock() || canTranscribe(),
    writing: isMock() || canWrite(),
    publishing: canPublish(),
    mock: isMock(),
  });
}
