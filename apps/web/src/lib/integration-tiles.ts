import type * as React from "react";
import {
  GithubTile,
  GmailTile,
  GoogleCalendarTile,
  GoogleDocsTile,
  GoogleDriveTile,
  GoogleSheetsTile,
  GoogleSlidesTile,
  LinearTile,
  NotionTile,
  RailwayTile,
  SlackTile,
  VercelTile,
} from "~/lib/integration-tile-components";

export type IntegrationTileSlug =
  | "gmail"
  | "google_calendar"
  | "google_drive"
  | "google_docs"
  | "google_sheets"
  | "google_slides"
  | "github"
  | "linear"
  | "notion"
  | "railway"
  | "slack"
  | "vercel";

export const INTEGRATION_TILES: Record<
  IntegrationTileSlug,
  React.FC<React.ComponentPropsWithoutRef<"svg">>
> = {
  gmail: GmailTile,
  google_calendar: GoogleCalendarTile,
  google_drive: GoogleDriveTile,
  google_docs: GoogleDocsTile,
  google_sheets: GoogleSheetsTile,
  google_slides: GoogleSlidesTile,
  github: GithubTile,
  linear: LinearTile,
  notion: NotionTile,
  railway: RailwayTile,
  slack: SlackTile,
  vercel: VercelTile,
};
