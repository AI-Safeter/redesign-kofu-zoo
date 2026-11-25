// Tells the browser which features are available on this deployment.
import { json, isMock } from "./_lib/http.js";
import { accessStatus } from "./_lib/access.js";
import { canTranscribe } from "./transcribe.js";
import { canWrite } from "./_lib/writer.js";
import { canPublish } from "./_lib/books.js";

export async function GET(request) {
  const access = await accessStatus(request);
  return json({
    accessCodeRequired: Boolean(process.env.ACCESS_CODE),
    accessOk: access === "ok", // whether the x-access-code header sent is right
    accessLocked: access === "locked", // too many wrong tries from this address
    transcription: isMock() || canTranscribe(),
    writing: isMock() || canWrite(),
    publishing: canPublish(),
    mock: isMock(),
  });
}
