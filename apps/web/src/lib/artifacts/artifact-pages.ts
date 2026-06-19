import sycamorePage1 from "./artifact-html/sycamore-pdf/page-1-cover.html?raw";
import sycamorePage2 from "./artifact-html/sycamore-pdf/page-2-person-solo.html?raw";
import sycamorePage3 from "./artifact-html/sycamore-pdf/page-3-person-solo-with-recognitions.html?raw";
import sycamorePage4 from "./artifact-html/sycamore-pdf/page-4-person-duo.html?raw";
import sycamorePage5 from "./artifact-html/sycamore-pdf/page-5-person-plus-role-grid.html?raw";
import sycamorePage6 from "./artifact-html/sycamore-pdf/page-6-strategy.html?raw";

export type ArtifactPage = {
  title: string;
  kicker: string;
  body: string;
  html?: string;
};

export const SYCAMORE_BRIEF_PAGES: ReadonlyArray<ArtifactPage> = [
  {
    title: "Sycamore Labs",
    kicker: "Research Briefing",
    body: "Key people, connection strategy, and role preparation guide.",
    html: sycamorePage1,
  },
  {
    title: "Founder Profile",
    kicker: "Key People",
    body: "A principal decision-maker profile with background, priorities, and likely interview angles.",
    html: sycamorePage2,
  },
  {
    title: "Technical Leadership",
    kicker: "Key People",
    body: "A second profile page covering career signals, recognitions, and technical credibility.",
    html: sycamorePage3,
  },
  {
    title: "Connection Map",
    kicker: "People Strategy",
    body: "Two compact relationship blocks with context and connection angles.",
    html: sycamorePage4,
  },
  {
    title: "Role Grid",
    kicker: "Hiring Signal",
    body: "Open-role and relevance mapping for an applied AI engineering interview.",
    html: sycamorePage5,
  },
  {
    title: "Interview Strategy",
    kicker: "Preparation",
    body: "Talking points, sharp questions, and final positioning strategy.",
    html: sycamorePage6,
  },
];
