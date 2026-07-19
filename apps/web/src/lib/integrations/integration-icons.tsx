import { Check, Globe2, Users, type LucideIcon } from "lucide-react";
import { useId } from "react";
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
} from "~/lib/integrations/integration-tile-components";
import { cn } from "~/lib/utils";

// Auto-generated from dimension.dev integration SVGs (public brand assets).
// Source artwork is authored in a 50x50 grid; the actual glyph paths
// occupy the inner ~[8,42] x [8,42] region. `IntegrationGlyph` renders
// these inside `<svg viewBox="8 8 34 34">` so icons fill the visible
// space at small rail sizes (12–32px). The crop intentionally clips a
// few units of drop-shadow on the doc-family glyphs (google_docs,
// google_slides, google_sheets) — imperceptible at our rendering sizes
// and an acceptable trade for the tighter optical fit.
//
// `__UID0__` is substituted with a useId() value at render time so
// multiple instances of the same icon on a page do not collide on
// filter or clip-path IDs.

type BrandSvgSlug =
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

const BRAND_SVGS: Record<BrandSvgSlug, string> = {
  gmail: `<path d="M12.9091 35.7161H17.3636V24.6782L11 19.8086V33.7682C11 34.846 11.8559 35.7161 12.9091 35.7161Z" fill="#4285F4"></path><path d="M32.6367 35.7161H37.0913C38.1476 35.7161 39.0004 34.8428 39.0004 33.7682V19.8086L32.6367 24.6782" fill="#34A853"></path><path d="M32.6365 16.2376V24.6783L39.0001 19.8086V17.2115C39.0001 14.8026 36.3051 13.4294 34.4183 14.8741" fill="#FBBC04"></path><path d="M17.3633 24.678V16.2373L24.9996 22.0809L32.636 16.2373V24.678L24.9996 30.5216" fill="#EA4335"></path><path d="M11 17.2115V19.8086L17.3636 24.6783V16.2376L15.5818 14.8741C13.6918 13.4294 11 14.8026 11 17.2115Z" fill="#C5221F"></path>`,
  google_calendar: `<path d="M32.3691 17.6313L25.7377 16.8945L17.6325 17.6313L16.8955 24.9997L17.6323 32.3682L25.0007 33.2892L32.3691 32.3682L33.1059 24.8156L32.3691 17.6313Z" fill="white"></path><path d="M20.654 29.0632C20.1032 28.6911 19.7218 28.1477 19.5137 27.4293L20.7921 26.9024C20.9082 27.3446 21.1108 27.6871 21.4 27.9303C21.6874 28.1735 22.0374 28.2932 22.4464 28.2932C22.8645 28.2932 23.2238 28.1661 23.5239 27.9118C23.8241 27.6576 23.9753 27.3334 23.9753 26.9411C23.9753 26.5396 23.8168 26.2115 23.5 25.9574C23.1832 25.7034 22.7853 25.5761 22.31 25.5761H21.5714V24.3106H22.2344C22.6433 24.3106 22.9879 24.2002 23.2679 23.9791C23.5479 23.7581 23.6879 23.456 23.6879 23.071C23.6879 22.7284 23.5626 22.4557 23.3121 22.2513C23.0617 22.0469 22.7447 21.9437 22.3597 21.9437C21.9839 21.9437 21.6855 22.0432 21.4644 22.244C21.2434 22.4447 21.0831 22.6916 20.9818 22.9826L19.7164 22.4558C19.884 21.9805 20.1917 21.5605 20.6429 21.1976C21.0943 20.8348 21.6708 20.6523 22.3708 20.6523C22.8883 20.6523 23.3544 20.7519 23.7671 20.9526C24.1797 21.1534 24.5039 21.4316 24.7379 21.7852C24.9718 22.1407 25.0879 22.5387 25.0879 22.9807C25.0879 23.432 24.9792 23.8132 24.7618 24.1264C24.5444 24.4396 24.2773 24.679 23.9604 24.8467V24.9222C24.3786 25.0972 24.7194 25.3643 24.9883 25.7235C25.2554 26.0827 25.3898 26.512 25.3898 27.013C25.3898 27.5141 25.2627 27.9617 25.0085 28.3541C24.7542 28.7465 24.4024 29.0559 23.9567 29.2806C23.5091 29.5053 23.0062 29.6195 22.448 29.6195C21.8015 29.6214 21.2047 29.4353 20.654 29.0632Z" fill="#1A73E8"></path><path d="M28.4998 22.7196L27.1034 23.7345L26.4016 22.6699L28.9198 20.8535H29.8851V29.421H28.4998V22.7196Z" fill="#1A73E8"></path><path d="M32.3691 38.9996L39.0006 32.3682L35.6849 30.8945L32.3691 32.3682L30.8955 35.6839L32.3691 38.9996Z" fill="#EA4335"></path><path d="M16.1582 35.6849L17.6318 39.0006H32.3685V32.3691H17.6318L16.1582 35.6849Z" fill="#34A853"></path><path d="M13.2104 11C11.9892 11 11 11.9892 11 13.2104V32.3681L14.3157 33.8417L17.6315 32.3681V17.6317L25.7367 16.8949L32.3682 17.6317L33.105 24.8154L32.3682 32.3682L25.0008 33.2893L17.6324 32.3681L16.8956 24.9997L17.6323 17.6313L25.7375 16.8945L32.369 17.6313L39.0005 24.8156L39.0005 13.2104C39.0005 11.9892 38.0113 11 36.7901 11H13.2104Z" fill="none"></path>`,
  google_drive: `<path d="M13.0412 33.5913L14.2319 35.643C14.4793 36.0749 14.835 36.4143 15.2525 36.6611L19.505 29.3184H11C11 29.7966 11.1237 30.2748 11.3711 30.7067L13.0412 33.5913Z" fill="#0066DA"></path><g filter="url(#filter0_i___UID0__)"><path d="M24.4998 20.6816L20.2473 13.3389C19.8298 13.5857 19.4741 13.9251 19.2267 14.357L11.3711 27.9318C11.1283 28.3544 11.0003 28.833 11 29.3201H19.505L24.4998 20.6816Z" fill="#00AC47"></path></g><path d="M33.7483 36.6611C34.1658 36.4143 34.5214 36.0749 34.7689 35.643L35.2637 34.7946L37.6296 30.7067C37.8771 30.2748 38.0008 29.7966 38.0008 29.3184H29.4951L31.305 32.8663L33.7483 36.6611Z" fill="#EA4335"></path><path d="M24.4996 20.6807L28.7521 13.338C28.3346 13.0912 27.8552 12.9678 27.3604 12.9678H21.6388C21.144 12.9678 20.6646 13.1066 20.2471 13.338L24.4996 20.6807Z" fill="#00832D"></path><path d="M29.494 29.3184H19.5045L15.252 36.6611C15.6695 36.9079 16.1488 37.0313 16.6437 37.0313H32.3548C32.8497 37.0313 33.329 36.8925 33.7465 36.6611L29.494 29.3184Z" fill="#2684FC"></path><g filter="url(#filter1_i___UID0__)"><path d="M33.7009 21.1434L29.7731 14.356C29.5257 13.9241 29.17 13.5847 28.7525 13.3379L24.5 20.6806L29.4948 29.3191H37.9844C37.9844 28.8409 37.8606 28.3627 37.6132 27.9308L33.7009 21.1434Z" fill="#FFBA00"></path></g><defs><filter id="filter0_i___UID0__" x="11" y="13.3389" width="13.4998" height="17.9814" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"></feColorMatrix><feOffset dy="2"></feOffset><feGaussianBlur stdDeviation="2"></feGaussianBlur><feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"></feComposite><feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.25 0"></feColorMatrix><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow___UID0__"></feBlend><feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow___UID0__" result="shape"></feBlend></filter><filter id="filter1_i___UID0__" x="24.5" y="13.3379" width="13.4844" height="17.9812" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"></feColorMatrix><feOffset dy="2"></feOffset><feGaussianBlur stdDeviation="2"></feGaussianBlur><feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"></feComposite><feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.25 0"></feColorMatrix><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow___UID0__"></feBlend><feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow___UID0__" result="shape"></feBlend></filter></defs></path>`,
  google_docs: `<g><path d="M27.9181 9.08984H15.5139C14.31 9.08984 13.325 10.0661 13.325 11.2594V38.74C13.325 39.9332 14.31 40.9095 15.5139 40.9095H34.485C35.689 40.9095 36.674 39.9332 36.674 38.74V17.7679L31.5664 14.1521L27.9181 9.08984Z" fill="url(#paint1_linear___UID0__)"></path><path d="M28.5593 17.1338L36.675 25.1755V17.7684L28.5593 17.1338Z" fill="url(#paint2_linear___UID0__)"></path><g filter="url(#filter0_dddd___UID0__)"><path d="M19.1626 31.5086C19.1626 31.908 19.4864 32.2317 19.8858 32.2317H30.114C30.5134 32.2317 30.8371 31.908 30.8371 31.5086V31.5086C30.8371 31.1092 30.5134 30.7854 30.114 30.7854H19.8858C19.4864 30.7854 19.1626 31.1092 19.1626 31.5086V31.5086ZM19.1626 34.4013C19.1626 34.8007 19.4864 35.1244 19.8858 35.1244H27.1953C27.5947 35.1244 27.9185 34.8007 27.9185 34.4013V34.4013C27.9185 34.0019 27.5947 33.6781 27.1953 33.6781H19.8858C19.4864 33.6781 19.1626 34.0019 19.1626 34.4013V34.4013ZM19.8858 25C19.4864 25 19.1626 25.3238 19.1626 25.7232V25.7232C19.1626 26.1226 19.4864 26.4463 19.8858 26.4463H30.114C30.5134 26.4463 30.8371 26.1226 30.8371 25.7232V25.7232C30.8371 25.3238 30.5134 25 30.114 25H19.8858ZM19.1626 28.6159C19.1626 29.0153 19.4864 29.339 19.8858 29.339H30.114C30.5134 29.339 30.8371 29.0153 30.8371 28.6159V28.6159C30.8371 28.2165 30.5134 27.8927 30.114 27.8927H19.8858C19.4864 27.8927 19.1626 28.2165 19.1626 28.6159V28.6159Z" fill="url(#paint3_linear___UID0__)"></path></g><path d="M27.9192 9.08984V15.5984C27.9192 16.7971 28.8988 17.7679 30.1082 17.7679H36.6751L27.9192 9.08984Z" fill="#A1C2FA"></path><path d="M15.5139 9.08984C14.31 9.08984 13.325 10.0661 13.325 11.2594V11.4402C13.325 10.2469 14.31 9.27064 15.5139 9.27064H27.9181V9.08984H15.5139Z" fill="white" fill-opacity="0.2"></path><path d="M34.485 40.7281H15.5139C14.31 40.7281 13.325 39.7518 13.325 38.5586V38.7394C13.325 39.9326 14.31 40.9089 15.5139 40.9089H34.485C35.689 40.9089 36.674 39.9326 36.674 38.7394V38.5586C36.674 39.7518 35.689 40.7281 34.485 40.7281Z" fill="#1A237E" fill-opacity="0.1"></path><defs><linearGradient id="paint1_linear___UID0__" x1="13.325" y1="9.08984" x2="36.674" y2="40.9095" gradientUnits="userSpaceOnUse"><stop stop-color="#4285F4"></stop><stop offset="1" stop-color="#1F6CED"></stop></linearGradient><linearGradient id="paint2_linear___UID0__" x1="28.5593" y1="17.1338" x2="36.675" y2="25.1755" gradientUnits="userSpaceOnUse"><stop stop-color="#0066DA"></stop><stop offset="1" stop-color="#00AC47" stop-opacity="0"></stop></linearGradient><linearGradient id="paint3_linear___UID0__" x1="19.1626" y1="25" x2="30.8371" y2="35.1244" gradientUnits="userSpaceOnUse"><stop></stop><stop offset="1" stop-color="#1A237E" stop-opacity="0.3"></stop></linearGradient><filter id="filter0_dddd___UID0__" x="17.1626" y="28.7854" width="15.6746" height="10.339" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"></feColorMatrix><feOffset dy="2"></feOffset><feGaussianBlur stdDeviation="1"></feGaussianBlur><feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"></feComposite><feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.18 0"></feColorMatrix><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow___UID0__"></feBlend><feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow___UID0__" result="shape"></feBlend></filter></defs></g>`,
  google_sheets: `<g filter="url(#filter0_i___UID0__)"><path d="M27.75 9.9502H16.0625C14.9281 9.9502 14 10.8737 14 12.0024V37.9975C14 39.1262 14.9281 40.0497 16.0625 40.0497H33.9375C35.0719 40.0497 36 39.1262 36 37.9975V18.1592L31.1875 14.7388L27.75 9.9502Z" fill="url(#paint1_linear___UID0__)"></path></g><g filter="url(#filter1_dddd___UID0__)"><path d="M20.5149 24.6582C19.9544 24.6582 19.5 25.1126 19.5 25.6731V33.5625C19.5 34.123 19.9544 34.5774 20.5149 34.5774H29.4851C30.0456 34.5774 30.5 34.123 30.5 33.5625V25.6731C30.5 25.1126 30.0456 24.6582 29.4851 24.6582H20.5149ZM24.3125 33.2092H20.875V31.499H24.3125V33.2092ZM24.3125 30.4729H20.875V28.7627H24.3125V30.4729ZM24.3125 27.7366H20.875V26.0264H24.3125V27.7366ZM29.125 33.2092H25.6875V31.499H29.125V33.2092ZM29.125 30.4729H25.6875V28.7627H29.125V30.4729ZM29.125 27.7366H25.6875V26.0264H29.125V27.7366Z" fill="url(#paint2_linear___UID0__)"></path></g><path d="M27.75 9.9502V16.1069C27.75 17.2408 28.673 18.1591 29.8125 18.1591H36L27.75 9.9502Z" fill="#87CEAC"></path><path d="M16.0625 9.9502C14.9281 9.9502 14 10.8737 14 12.0024V12.1735C14 11.0447 14.9281 10.1212 16.0625 10.1212H27.75V9.9502H16.0625Z" fill="white" fill-opacity="0.2"></path><path d="M29.812 18.1587C28.6725 18.1587 27.7495 17.2403 27.7495 16.1064V16.2775C27.7495 17.4113 28.6725 18.3297 29.812 18.3297H35.9995V18.1587H29.812Z" fill="#263238" fill-opacity="0.1"></path><defs><filter id="filter0_i___UID0__" x="14" y="9.9502" width="22" height="30.0996" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"></feColorMatrix><feOffset></feOffset><feGaussianBlur stdDeviation="1.52233"></feGaussianBlur><feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"></feComposite><feColorMatrix type="matrix" values="0 0 0 0 0.858824 0 0 0 0 0.8 0 0 0 0 0.8 0 0 0 0.4 0"></feColorMatrix><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow___UID0__"></feBlend><feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow___UID0__" result="shape"></feBlend></filter><filter id="filter1_dddd___UID0__" x="17.5" y="24.6582" width="15" height="12.9192" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"></feColorMatrix><feOffset dy="2"></feOffset><feGaussianBlur stdDeviation="1"></feGaussianBlur><feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"></feComposite><feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.18 0"></feColorMatrix><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow___UID0__"></feBlend><feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow___UID0__" result="shape"></feBlend></filter><linearGradient id="paint1_linear___UID0__" x1="14" y1="9.9502" x2="36" y2="40.0497" gradientUnits="userSpaceOnUse"><stop stop-color="#30BC78"></stop><stop offset="1" stop-color="#0B9F57"></stop></linearGradient><linearGradient id="paint2_linear___UID0__" x1="19.5" y1="24.6582" x2="30.5" y2="34.5774" gradientUnits="userSpaceOnUse"><stop></stop><stop offset="1" stop-color="#1A237E" stop-opacity="0.3"></stop></linearGradient></defs></path>`,
  google_slides: `<path d="M33.9375 40.0497H16.0625C14.9281 40.0497 14 39.1262 14 37.9975V12.0024C14 10.8737 14.9281 9.9502 16.0625 9.9502H28.4375L36 17.4751V37.9975C36 39.1262 35.0719 40.0497 33.9375 40.0497Z" fill="url(#paint1_linear___UID0__)"></path><g filter="url(#filter0_dddd___UID0__)"><path d="M19.126 21.751C18.5737 21.751 18.126 22.1987 18.126 22.751V30.3281C18.126 30.8804 18.5737 31.3281 19.126 31.3281H30.876C31.4283 31.3281 31.876 30.8804 31.876 30.3281V22.751C31.876 22.1987 31.4283 21.751 30.876 21.751H19.126ZM30.1572 29.5179C30.1572 29.5731 30.1125 29.6179 30.0572 29.6179H19.9447C19.8895 29.6179 19.8447 29.5731 19.8447 29.5179V23.5612C19.8447 23.5059 19.8895 23.4612 19.9447 23.4612H30.0572C30.1125 23.4612 30.1572 23.5059 30.1572 23.5612V29.5179Z" fill="url(#paint2_linear___UID0__)"></path></g><path d="M28.4375 9.9502L36 17.4751H30.4542C29.3404 17.4751 28.4375 16.5767 28.4375 15.4684V9.9502Z" fill="url(#paint3_linear___UID0__)"></path><defs><filter id="filter0_dddd___UID0__" x="15.126" y="20.751" width="19.75" height="20.5771" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"></feColorMatrix><feOffset></feOffset><feGaussianBlur stdDeviation="0.5"></feGaussianBlur><feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0.34902 0 0 0 0 0 0 0 0 0.21 0"></feColorMatrix><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow___UID0__"></feBlend><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"></feColorMatrix><feOffset dy="2"></feOffset><feGaussianBlur stdDeviation="1"></feGaussianBlur><feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0.34902 0 0 0 0 0 0 0 0 0.18 0"></feColorMatrix><feBlend mode="normal" in2="effect1_dropShadow___UID0__" result="effect2_dropShadow___UID0__"></feBlend><feBlend mode="normal" in="SourceGraphic" in2="effect2_dropShadow___UID0__" result="shape"></feBlend></filter><linearGradient id="paint1_linear___UID0__" x1="14" y1="9.9502" x2="36" y2="40.0497" gradientUnits="userSpaceOnUse"><stop stop-color="#F8BF08"></stop><stop offset="1" stop-color="#F8B008"></stop></linearGradient><linearGradient id="paint2_linear___UID0__" x1="18.126" y1="21.751" x2="31.876" y2="31.3281" gradientUnits="userSpaceOnUse"><stop></stop><stop offset="1" stop-color="#1A237E" stop-opacity="0.3"></stop></linearGradient><linearGradient id="paint3_linear___UID0__" x1="28.4375" y1="9.9502" x2="36" y2="17.4751" gradientUnits="userSpaceOnUse"><stop stop-color="#FFBA00"></stop><stop offset="1" stop-color="#EA4335"></stop></linearGradient></defs></path>`,
  github: `<g><path d="M25.001 8.63984C34.025 8.63984 41.334 15.9489 41.334 24.9728C41.3317 31.9902 36.8552 38.2247 30.2077 40.4682C29.3911 40.6315 29.0842 40.1205 29.0842 39.6924C29.0842 39.1406 29.1052 37.3848 29.1052 35.2008C29.1052 33.6702 28.5954 32.6902 28.0028 32.1792C31.6368 31.7709 35.4553 30.3826 35.4553 24.1154C35.4553 22.3187 34.8218 20.8686 33.7811 19.7264C33.9445 19.3181 34.5161 17.644 33.6178 15.3982C33.6178 15.3982 32.2493 14.949 29.1262 17.0723C27.8196 16.7048 26.4313 16.5217 25.043 16.5217C23.6547 16.5217 22.2664 16.7048 20.9597 17.0723C17.8366 14.97 16.4681 15.3982 16.4681 15.3982C15.5698 17.644 16.1415 19.3181 16.3048 19.7264C15.2642 20.8698 14.6307 22.3397 14.6307 24.1154C14.6307 30.3627 18.4281 31.772 22.0622 32.1804C21.592 32.5887 21.1639 33.3038 21.0204 34.3643C20.0812 34.7936 17.7328 35.4878 16.264 33.0168C15.9572 32.5269 15.039 31.3229 13.7534 31.3427C12.3849 31.3637 13.2027 32.1185 13.7732 32.4242C14.4674 32.8115 15.263 34.2617 15.4473 34.7318C15.774 35.65 16.8356 37.4069 20.9387 36.6509C20.9387 38.0194 20.9597 39.3051 20.9597 39.6924C20.9597 40.1217 20.6529 40.6105 19.8362 40.4682C13.1642 38.2469 8.66447 32.0042 8.66797 24.9717C8.66797 15.9477 15.977 8.63984 25.001 8.63984Z" fill="currentColor"></path></g>`,
  linear: `<g><path d="M11.1792 28.265C11.1162 27.9962 11.4364 27.8269 11.6315 28.0221L21.9767 38.3673C22.1719 38.5625 22.0026 38.8827 21.7339 38.8196C16.5133 37.5949 12.4039 33.4856 11.1792 28.265ZM10.8326 24.1187C10.8276 24.199 10.8577 24.2774 10.9146 24.3342L25.6646 39.0842C25.7215 39.1411 25.7999 39.1714 25.8801 39.1663C26.5514 39.1245 27.21 39.0359 27.8528 38.9039C28.0694 38.8595 28.1447 38.5933 27.9883 38.437L11.5619 22.0106C11.4055 21.8542 11.1394 21.9294 11.0949 22.1461C10.9629 22.7888 10.8744 23.4475 10.8326 24.1187ZM12.0251 19.25C11.978 19.3559 12.002 19.4797 12.084 19.5617L30.4372 37.9149C30.5192 37.9969 30.6429 38.0209 30.7488 37.9737C31.2549 37.7483 31.7453 37.4941 32.2181 37.2133C32.3745 37.1203 32.3986 36.9054 32.27 36.7767L13.2221 17.7289C13.0935 17.6002 12.8785 17.6244 12.7856 17.7808C12.5047 18.2535 12.2505 18.744 12.0251 19.25ZM14.4187 15.9545C14.3138 15.8496 14.3073 15.6814 14.4061 15.5708C17.0029 12.6636 20.7803 10.8335 24.9851 10.8335C32.8166 10.8335 39.1654 17.1822 39.1654 25.0138C39.1654 29.2186 37.3352 32.996 34.4281 35.5927C34.3175 35.6915 34.1493 35.6851 34.0444 35.5802L14.4187 15.9545Z" fill="currentColor"></path></g>`,
  slack: `<path fill-rule="evenodd" clip-rule="evenodd" d="M16.3154 28.9467C16.3154 30.6907 14.9017 32.1044 13.1577 32.1044C11.4137 32.1044 10 30.6907 10 28.9467C10 27.2028 11.4137 25.7891 13.1577 25.7891H16.3154V28.9467Z" fill="#E01E5A"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M17.8955 28.9467C17.8955 27.2028 19.3092 25.7891 21.0532 25.7891C22.7972 25.7891 24.2109 27.2028 24.2109 28.9467V36.841C24.2109 38.5849 22.7972 39.9987 21.0532 39.9987C19.3092 39.9987 17.8955 38.5849 17.8955 36.841V28.9467Z" fill="#E01E5A"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M21.0532 16.3154C19.3092 16.3154 17.8955 14.9017 17.8955 13.1577C17.8955 11.4137 19.3092 10 21.0532 10C22.7972 10 24.2109 11.4137 24.2109 13.1577V16.3154H21.0532Z" fill="#36C5F0"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M21.0519 17.8945C22.7959 17.8945 24.2096 19.3082 24.2096 21.0522C24.2096 22.7962 22.7959 24.2099 21.0519 24.2099H13.1577C11.4137 24.2099 10 22.7962 10 21.0522C10 19.3082 11.4137 17.8945 13.1577 17.8945H21.0519Z" fill="#36C5F0"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M33.6843 21.0522C33.6843 19.3082 35.098 17.8945 36.842 17.8945C38.586 17.8945 39.9997 19.3082 39.9997 21.0522C39.9997 22.7962 38.586 24.2099 36.842 24.2099H33.6843V21.0522Z" fill="#2EB67D"></path><g filter="url(#filter0_i___UID0__)"><path fill-rule="evenodd" clip-rule="evenodd" d="M32.1042 21.0519C32.1042 22.7959 30.6905 24.2096 28.9465 24.2096C27.2025 24.2096 25.7888 22.7959 25.7888 21.0519V13.1577C25.7888 11.4137 27.2025 10 28.9465 10C30.6905 10 32.1042 11.4137 32.1042 13.1577V21.0519Z" fill="url(#paint1_linear___UID0__)"></path></g><path fill-rule="evenodd" clip-rule="evenodd" d="M28.9467 33.6826C30.6907 33.6826 32.1044 35.0964 32.1044 36.8403C32.1044 38.5843 30.6907 39.998 28.9467 39.998C27.2028 39.998 25.7891 38.5843 25.7891 36.8403V33.6826H28.9467Z" fill="#ECB22E"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M28.9465 32.1044C27.2025 32.1044 25.7888 30.6907 25.7888 28.9467C25.7888 27.2028 27.2025 25.7891 28.9465 25.7891C30.6905 25.7891 32.1042 27.2028 32.1042 28.9467C32.1042 30.6907 30.6905 32.1044 28.9465 32.1044ZM28.9465 33.6826V39.998C27.2025 39.998 25.7888 38.5843 25.7888 36.8403C25.7888 35.0964 27.2025 33.6826 28.9465 33.6826Z" fill="white"></path><defs><filter id="filter0_i___UID0__" x="25.7888" y="10" width="8.31531" height="14.2096" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood><feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"></feColorMatrix><feOffset></feOffset><feGaussianBlur stdDeviation="0.5"></feGaussianBlur><feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"></feComposite><feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.25 0"></feColorMatrix><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow___UID0__"></feBlend><feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow___UID0__" result="shape"></feBlend></filter><linearGradient id="paint1_linear___UID0__" x1="25.7888" y1="10" x2="32.1042" y2="24.2096" gradientUnits="userSpaceOnUse"><stop stop-color="white"></stop><stop offset="1" stop-color="white" stop-opacity="0"></stop></linearGradient></defs></path>`,
  // Monochrome marks (currentColor) — like github/linear, these brand glyphs
  // are a single-tone logo, so IntegrationGlyph tints them theme-aware.
  notion: `<path fill-rule="evenodd" clip-rule="evenodd" d="M29.1559 9.76696L12.2566 11.0152C10.8932 11.1331 10.4189 12.0239 10.4189 13.0917V31.6178C10.4189 32.4495 10.7143 33.1611 11.4268 34.1121L15.3993 39.2775C16.0519 40.1092 16.6453 40.2875 17.8914 40.2283L37.5162 39.0402C39.1755 38.922 39.651 38.1493 39.651 36.8434V16.0013C39.651 15.3263 39.3844 15.1318 38.5995 14.5558L33.0703 10.6575C31.7653 9.70862 31.2317 9.5886 29.1559 9.76665V9.76696ZM18.3352 15.6602C16.7327 15.768 16.3693 15.7924 15.4591 15.0524L13.1453 13.212C12.9102 12.9738 13.0284 12.6766 13.6209 12.6174L29.8666 11.4302C31.2308 11.3111 31.9412 11.7866 32.4748 12.202L35.261 14.2208C35.3801 14.2809 35.6764 14.6361 35.32 14.6361L18.5429 15.6461L18.3352 15.6602ZM16.467 36.6654V18.972C16.467 18.1993 16.7043 17.8429 17.4147 17.7831L36.6842 16.6549C37.3378 16.5959 37.6331 17.0113 37.6331 17.7828V35.3582C37.6331 36.1309 37.514 36.7845 36.4472 36.8434L18.0075 37.9123C16.9407 37.9713 16.4673 37.6161 16.4673 36.6654H16.467ZM34.6694 19.9206C34.7876 20.4551 34.6694 20.9896 34.135 21.0506L33.2462 21.2269V34.2902C32.4745 34.7055 31.7641 34.9428 31.1704 34.9428C30.2214 34.9428 29.9844 34.6457 29.2738 33.7557L23.4618 24.6117V33.4585L25.3004 33.8748C25.3004 33.8748 25.3004 34.9438 23.817 34.9438L19.7275 35.1811C19.6084 34.9428 19.7275 34.3494 20.142 34.2312L21.21 33.935V22.2378L19.7279 22.1177C19.6087 21.5833 19.905 20.8115 20.7357 20.7516L25.1235 20.4563L31.1707 29.7185V21.5243L29.6293 21.3472C29.5101 20.6927 29.9844 20.2172 30.5769 20.1592L34.6694 19.9206Z" fill="currentColor"></path>`,
  railway: `<path d="M7.82509 22.5005C7.7425 23.0793 7.68876 23.662 7.66406 24.2462H33.9983C33.9063 24.0665 33.7828 23.9045 33.6582 23.746C29.1562 17.9296 26.7344 18.4339 23.2701 18.2862C22.1151 18.2387 21.3318 18.2196 16.7344 18.2196C14.2737 18.2196 11.5986 18.2259 8.99364 18.2328C8.65642 19.143 8.33119 20.0253 8.17284 20.743H21.6674V22.5005H7.82509ZM34.2059 26.0054H7.67757C7.70533 26.4744 7.74908 26.9371 7.81226 27.3935H32.3043C33.3962 27.3935 34.0073 26.7741 34.2059 26.0054ZM9.18822 32.1881C9.18822 32.1881 13.2485 42.1579 24.9807 42.335C31.993 42.335 38.0182 38.1703 40.7551 32.1881H9.18822Z" fill="currentColor"></path><path d="M24.9805 7.66504C18.4968 7.66504 12.8548 11.2255 9.87528 16.4887C12.2037 16.4838 16.7383 16.481 16.7383 16.481H16.7394V16.4793C22.0993 16.4793 22.2985 16.5032 23.3455 16.5469L23.9939 16.5708C26.2522 16.6461 29.0279 16.8886 31.2119 18.541C32.3974 19.4372 34.1091 21.4154 35.1295 22.8246C36.0728 24.1281 36.3441 25.6265 35.7028 27.0622C35.1125 28.3816 33.8423 29.1686 32.3041 29.1686H8.22914C8.22914 29.1686 8.37246 29.7761 8.58735 30.4467H41.4504C42.034 28.6926 42.3323 26.8561 42.334 25.0074C42.3343 15.4304 34.5648 7.66504 24.9805 7.66504Z" fill="currentColor"></path>`,
  vercel: `<path d="M37.6934 35.7358L25 13.75L12.3066 35.7358H37.6934Z" fill="currentColor"></path>`,
};

type BrandIconMeta =
  | {
      kind: "svg";
      slug: BrandSvgSlug;
      // currentColor brand fallback for marks whose dimension source uses a
      // white-on-dark gradient (github, linear). Other multicolor SVGs ignore
      // currentColor entirely.
      plainColor?: string;
      frostColor?: string;
    }
  | {
      kind: "lucide";
      icon: LucideIcon;
      color: string;
    };

/**
 * Identity helper that infers the brand keys while pinning every value to
 * `BrandIconMeta`. This lets `IntegrationBrand` derive from the map's keys — so
 * the union can never drift from the icons it describes — without `as const`
 * fracturing the shared meta shape into a per-entry union (which would break
 * the unconditional `plainColor`/`frostColor` reads in `IntegrationGlyph`).
 */
const defineBrandIcons = <K extends string>(
  icons: Record<K, BrandIconMeta>,
): Record<K, BrandIconMeta> => icons;

const BRAND_ICONS = defineBrandIcons({
  collaborators: { kind: "lucide", icon: Users, color: "#e5e7eb" },
  github: {
    kind: "svg",
    slug: "github",
    // Theme-aware on chrome: GitHub's mark is monochrome, so a fixed near-white
    // (#f4f4f5) vanished on light-mode surfaces (tool cards, connect row, mention
    // menu). --app-fg-4 tracks the primary text tone — dark in light mode, light
    // in dark mode. `frost` keeps white for the dark integration tiles.
    plainColor: "var(--app-fg-4)",
    frostColor: "#f4f4f5",
  },
  gmail: { kind: "svg", slug: "gmail" },
  google_calendar: { kind: "svg", slug: "google_calendar" },
  google_drive: { kind: "svg", slug: "google_drive" },
  google_docs: { kind: "svg", slug: "google_docs" },
  google_sheets: { kind: "svg", slug: "google_sheets" },
  google_slides: { kind: "svg", slug: "google_slides" },
  linear: {
    kind: "svg",
    slug: "linear",
    plainColor: "#5E6AD2",
    frostColor: "#ffffff",
  },
  slack: { kind: "svg", slug: "slack" },
  // Monochrome marks: like GitHub, the bare glyph is single-tone, so it tracks
  // --app-fg-4 on chrome (dark in light mode, light in dark) and stays white on
  // the dark integration tiles via `frost`. Full-color artwork lives in the
  // app-icon coins (integration-tile-components.tsx).
  notion: {
    kind: "svg",
    slug: "notion",
    plainColor: "var(--app-fg-4)",
    frostColor: "#f4f4f5",
  },
  railway: {
    kind: "svg",
    slug: "railway",
    plainColor: "var(--app-fg-4)",
    frostColor: "#f4f4f5",
  },
  vercel: {
    kind: "svg",
    slug: "vercel",
    plainColor: "var(--app-fg-4)",
    frostColor: "#f4f4f5",
  },
  web: { kind: "lucide", icon: Globe2, color: "#38bdf8" },
});

/**
 * Every integration brand Alfred can render an icon for. Derived from the
 * `BRAND_ICONS` keys so the union stays in lockstep with the icon map.
 */
export type IntegrationBrand = keyof typeof BRAND_ICONS;

/**
 * Per-brand accent color for ambient surfaces — the radial glow behind a
 * provider's detail-page hero (see `HeroPanel`). A brand is keyed here by its
 * primary brand *hue*, not by how its mark renders: Railway's glyph is
 * monochrome on chrome (see `BRAND_ICONS`) yet keeps its magenta glow. Brands
 * absent here (github, notion, vercel) are the ones whose brand color is
 * black/near-gray — a gray glow reads as no glow on the dark canvas — so they
 * fall back to Alfred's house purple (`--app-purple-2`). Values are applied at
 * low alpha via `color-mix`, so the saturation here is intentional — the
 * surface dilutes it.
 */
export const BRAND_ACCENT: Partial<Record<IntegrationBrand, string>> = {
  gmail: "#ea4335",
  google_calendar: "#4285f4",
  google_drive: "#ffb400",
  google_docs: "#4285f4",
  google_sheets: "#1fa463",
  google_slides: "#f9ab00",
  slack: "#a25da3",
  linear: "#5e6ad2",
  railway: "#8c1eaf",
};

const TILE_SIZE_CLASS = {
  sm: "size-7 rounded-full",
  md: "size-10 rounded-full",
  xs: "size-6 rounded-full",
} as const;

const GLYPH_SIZE = {
  sm: 18,
  md: 24,
  xs: 15,
} as const;

// Offsets sit the check on the tile's 4:30 edge. Because the corner of a circle
// recedes from its bounding box, the badge hugs the edge with a smaller outset
// than a square would need (a -1 outset on `md` would float clear of the rim).
const CHECK_SIZE_CLASS = {
  sm: "size-3.5 -bottom-0.5 -right-0.5",
  md: "size-4 -bottom-0.5 -right-0.5",
  xs: "size-3 -bottom-0.5 -right-0.5",
} as const;

/** Brands that ship a full-bleed app-icon tile (background + gloss baked in). */
function hasTile(
  brand: IntegrationBrand,
): brand is IntegrationBrand & keyof typeof INTEGRATION_TILES {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_TILES, brand);
}

type TileComponent = React.FC<React.ComponentPropsWithoutRef<"svg">>;

const INTEGRATION_TILES = {
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
} as const satisfies Record<string, TileComponent>;

/**
 * An integration's brand mark as a polished, full-bleed app-icon coin — the
 * artwork fills the circle edge-to-edge, lit by the gloss baked into each SVG,
 * and finished with a hairline frost border (no inner glow over the art). The
 * round tile is what makes these read as Alfred's own marks rather than stock
 * app-store tiles; it's used on connect surfaces, the approval tray, onboarding
 * and the integrations catalog. Inline contexts that want just the bare logo
 * next to text use `IntegrationGlyph` instead.
 *
 * Brands without bespoke artwork (`web`, `collaborators`) fall back to their
 * Lucide mark centered on a dark frost coin so every brand still renders a
 * tile rather than a naked glyph.
 */
export function IntegrationIcon({
  brand,
  connected = false,
  size = "sm",
  title,
  className,
}: {
  brand: IntegrationBrand;
  connected?: boolean;
  size?: keyof typeof TILE_SIZE_CLASS;
  /** Retained for source compatibility; tiles carry their own background. */
  variant?: "plain" | "frost";
  title?: string;
  className?: string;
}) {
  const badge = connected ? (
    <span
      className={cn(
        "absolute z-10 grid place-items-center rounded-full bg-emerald-400 text-black",
        // ring tracks the canvas so the check reads as a cut-out in both themes.
        "shadow-[0_1px_4px_rgba(0,0,0,0.28)] ring-2 ring-app-background",
        CHECK_SIZE_CLASS[size],
      )}
      title="Connected"
      aria-label="Connected"
    >
      <Check size={size === "md" ? 11 : 9} strokeWidth={3} />
    </span>
  ) : null;

  if (hasTile(brand)) {
    const Tile = INTEGRATION_TILES[brand];
    return (
      <span
        className={cn("relative block shrink-0", TILE_SIZE_CLASS[size], className)}
        title={title}
      >
        {/* Inner layer clips the full-bleed artwork to the circle. The
         * elevated shadow is a theme-aware hairline + soft drop: a faint dark
         * rim frames the light Google tiles on a light canvas, a faint light
         * rim lifts the dark GitHub/Linear tiles on dark. */}
        <span className="block size-full overflow-hidden rounded-[inherit] shadow-[var(--app-shadow-elevated)]">
          <Tile aria-hidden className="block size-full" />
        </span>
        {badge}
      </span>
    );
  }

  // No bespoke artwork (web, collaborators) — center the Lucide mark on a
  // theme-aware neutral tile so it stays in the same family as the app tiles
  // in both light and dark.
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center bg-app-bg-2 shadow-[var(--app-shadow-elevated)]",
        TILE_SIZE_CLASS[size],
        className,
      )}
      title={title}
    >
      <IntegrationGlyph brand={brand} size={GLYPH_SIZE[size]} />
      {badge}
    </span>
  );
}

export function IntegrationGlyph({
  brand,
  size = 22,
  variant = "plain",
  colorOverride,
  className,
}: {
  brand: IntegrationBrand;
  size?: number;
  variant?: "plain" | "frost";
  /** Override the brand's plain/frost color — needed when the surrounding
   * tile isn't the background tone the brand metadata assumes (e.g. the
   * monochrome GitHub glyph on a white tile). */
  colorOverride?: string;
  className?: string;
}) {
  const meta = BRAND_ICONS[brand];
  // useId is always called regardless of branch so hook order is stable.
  const reactId = useId();
  const uid = `ai_${reactId.replace(/[^a-zA-Z0-9_]/g, "_")}`;

  if (meta.kind === "lucide") {
    const Icon = meta.icon;
    return (
      <Icon
        size={size}
        className={cn("shrink-0", className)}
        style={{ color: colorOverride ?? meta.color }}
      />
    );
  }

  const color = colorOverride ?? (variant === "frost" ? meta.frostColor : meta.plainColor);
  // BRAND_SVGS is a hand-curated constant in source (see integration-svgs.ts);
  // there is no user-provided HTML path into this value, so the no-danger rule
  // is a false positive here. We use innerHTML to keep the SVG markup
  // verbatim (filter/clipPath IDs need to live inside the same <svg> element).
  const inner = BRAND_SVGS[meta.slug].replaceAll("__UID0__", uid);

  return (
    <svg
      aria-hidden
      className={cn("shrink-0", className)}
      fill="none"
      height={size}
      style={color ? { color } : undefined}
      viewBox="8 8 34 34"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}
