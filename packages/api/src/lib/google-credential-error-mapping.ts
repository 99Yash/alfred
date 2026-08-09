import { type AppErrorCode } from "@alfred/contracts/app-errors";
import { GoogleCredentialSelectionError, type GoogleAuthority } from "@alfred/integrations/google";

export function googleCredentialAppErrorCode(
  authority: GoogleAuthority,
  reason: GoogleCredentialSelectionError["reason"],
): AppErrorCode {
  switch (authority) {
    case "gmail_read":
    case "gmail_send":
      return reason === "scope_required" ? "gmail_scope_required" : "gmail_connection_required";
    case "calendar_read":
      return "calendar_read_connection_required";
    case "calendar_write":
      return "calendar_connection_required";
    case "drive":
      return reason === "scope_required" ? "drive_scope_required" : "drive_connection_required";
    case "docs":
      return reason === "scope_required" ? "docs_scope_required" : "google_connection_required";
    case "sheets":
      return reason === "scope_required" ? "sheets_scope_required" : "google_connection_required";
    case "slides":
      return reason === "scope_required" ? "slides_scope_required" : "google_connection_required";
    default: {
      const unhandled: never = authority;
      return unhandled;
    }
  }
}
