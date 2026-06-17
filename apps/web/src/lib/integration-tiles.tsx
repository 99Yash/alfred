/**
 * Full-bleed 50x50 "app-icon" integration tiles.
 *
 * These are ported verbatim from dimension's public brand SVGs: each tile bakes
 * in its own background fill and glossy top-light gradient, so it renders
 * edge-to-edge (the artwork fills the entire 50x50 viewBox) when drawn by
 * IntegrationIcon. They are intentionally distinct from the mark-only
 * BRAND_SVGS in integration-svgs.ts, which render the bare logo glyph inline
 * (no background, no gloss). Use these when you want the polished app-store
 * style tile; use BRAND_SVGS when you want just the logo mark.
 *
 * The `width="50" height="50"` attributes are hardcoded from the source, but
 * `{...props}` is spread last on each <svg>, so a caller passing className /
 * width / height overrides them as expected.
 */
import * as React from "react";

const GmailTile = (props: React.ComponentPropsWithoutRef<"svg">) => {
  const idJitter = React.useId();

  return (
    <svg
      width="50"
      height="50"
      viewBox="0 0 50 50"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect width="50" height="50" fill="#171717" />
      <rect width="50" height="50" fill={`url(#paint0_linear_${idJitter})`} />
      <path
        d="M12.9091 35.7161H17.3636V24.6782L11 19.8086V33.7682C11 34.846 11.8559 35.7161 12.9091 35.7161Z"
        fill="#4285F4"
      />
      <path
        d="M32.6367 35.7161H37.0913C38.1476 35.7161 39.0004 34.8428 39.0004 33.7682V19.8086L32.6367 24.6782"
        fill="#34A853"
      />
      <path
        d="M32.6365 16.2376V24.6783L39.0001 19.8086V17.2115C39.0001 14.8026 36.3051 13.4294 34.4183 14.8741"
        fill="#FBBC04"
      />
      <path
        d="M17.3633 24.678V16.2373L24.9996 22.0809L32.636 16.2373V24.678L24.9996 30.5216"
        fill="#EA4335"
      />
      <path
        d="M11 17.2115V19.8086L17.3636 24.6783V16.2376L15.5818 14.8741C13.6918 13.4294 11 14.8026 11 17.2115Z"
        fill="#C5221F"
      />
      <defs>
        <linearGradient
          id={`paint0_linear_${idJitter}`}
          x1="25"
          y1="6.5"
          x2="25"
          y2="50"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="#D9D9D9" />
        </linearGradient>
      </defs>
    </svg>
  );
};

const GoogleCalendarTile = (props: React.ComponentPropsWithoutRef<"svg">) => {
  const idJitter = React.useId();
  return (
    <svg
      width="50"
      height="50"
      viewBox="0 0 50 50"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect width="50.0006" height="50.0006" fill="#171717" />
      <rect width="50.0006" height="50.0006" fill={`url(#${idJitter})`} />
      <path
        d="M32.3691 17.6313L25.7377 16.8945L17.6325 17.6313L16.8955 24.9997L17.6323 32.3682L25.0007 33.2892L32.3691 32.3682L33.1059 24.8156L32.3691 17.6313Z"
        fill="white"
      />
      <path
        d="M20.654 29.0632C20.1032 28.6911 19.7218 28.1477 19.5137 27.4293L20.7921 26.9024C20.9082 27.3446 21.1108 27.6871 21.4 27.9303C21.6874 28.1735 22.0374 28.2932 22.4464 28.2932C22.8645 28.2932 23.2238 28.1661 23.5239 27.9118C23.8241 27.6576 23.9753 27.3334 23.9753 26.9411C23.9753 26.5396 23.8168 26.2115 23.5 25.9574C23.1832 25.7034 22.7853 25.5761 22.31 25.5761H21.5714V24.3106H22.2344C22.6433 24.3106 22.9879 24.2002 23.2679 23.9791C23.5479 23.7581 23.6879 23.456 23.6879 23.071C23.6879 22.7284 23.5626 22.4557 23.3121 22.2513C23.0617 22.0469 22.7447 21.9437 22.3597 21.9437C21.9839 21.9437 21.6855 22.0432 21.4644 22.244C21.2434 22.4447 21.0831 22.6916 20.9818 22.9826L19.7164 22.4558C19.884 21.9805 20.1917 21.5605 20.6429 21.1976C21.0943 20.8348 21.6708 20.6523 22.3708 20.6523C22.8883 20.6523 23.3544 20.7519 23.7671 20.9526C24.1797 21.1534 24.5039 21.4316 24.7379 21.7852C24.9718 22.1407 25.0879 22.5387 25.0879 22.9807C25.0879 23.432 24.9792 23.8132 24.7618 24.1264C24.5444 24.4396 24.2773 24.679 23.9604 24.8467V24.9222C24.3786 25.0972 24.7194 25.3643 24.9883 25.7235C25.2554 26.0827 25.3898 26.512 25.3898 27.013C25.3898 27.5141 25.2627 27.9617 25.0085 28.3541C24.7542 28.7465 24.4024 29.0559 23.9567 29.2806C23.5091 29.5053 23.0062 29.6195 22.448 29.6195C21.8015 29.6214 21.2047 29.4353 20.654 29.0632Z"
        fill="#1A73E8"
      />
      <path
        d="M28.4998 22.7196L27.1034 23.7345L26.4016 22.6699L28.9198 20.8535H29.8851V29.421H28.4998V22.7196Z"
        fill="#1A73E8"
      />
      <path
        d="M32.3691 38.9996L39.0006 32.3682L35.6849 30.8945L32.3691 32.3682L30.8955 35.6839L32.3691 38.9996Z"
        fill="#EA4335"
      />
      <path
        d="M16.1582 35.6849L17.6318 39.0006H32.3685V32.3691H17.6318L16.1582 35.6849Z"
        fill="#34A853"
      />
      <path
        d="M13.2104 11C11.9892 11 11 11.9892 11 13.2104V32.3681L14.3157 33.8417L17.6315 32.3681V17.6315H32.3681L33.8417 14.3157L32.3683 11H13.2104Z"
        fill="#4285F4"
      />
      <path
        d="M11 32.3682V36.7892C11 38.0105 11.9892 38.9996 13.2104 38.9996H17.6315V32.3682H11Z"
        fill="#188038"
      />
      <path
        d="M32.3682 17.6318V32.3685H38.9996V17.6318L35.6839 16.1582L32.3682 17.6318Z"
        fill="#FBBC04"
      />
      <path
        d="M38.9996 17.6315V13.2104C38.9996 11.9891 38.0104 11 36.7892 11H32.3682V17.6315H38.9996Z"
        fill="#1967D2"
      />
      <defs>
        <linearGradient
          id={`${idJitter}`}
          x1="25.0003"
          y1="6.50008"
          x2="25.0003"
          y2="50.0006"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="#D9D9D9" />
        </linearGradient>
      </defs>
    </svg>
  );
};

const GoogleDriveTile = (props: React.ComponentPropsWithoutRef<"svg">) => {
  const idJitter = React.useId();

  return (
    <svg
      width="50"
      height="50"
      viewBox="0 0 50 50"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect width="50" height="50" fill="#171717" />
      <rect width="50" height="50" fill={`url(#paint0_linear_${idJitter})`} />
      <path
        d="M13.0412 33.5913L14.2319 35.643C14.4793 36.0749 14.835 36.4143 15.2525 36.6611L19.505 29.3184H11C11 29.7966 11.1237 30.2748 11.3711 30.7067L13.0412 33.5913Z"
        fill="#0066DA"
      />
      <g filter={`url(#filter0_i_${idJitter})`}>
        <path
          d="M24.4998 20.6816L20.2473 13.3389C19.8298 13.5857 19.4741 13.9251 19.2267 14.357L11.3711 27.9318C11.1283 28.3544 11.0003 28.833 11 29.3201H19.505L24.4998 20.6816Z"
          fill="#00AC47"
        />
      </g>
      <path
        d="M33.7483 36.6611C34.1658 36.4143 34.5214 36.0749 34.7689 35.643L35.2637 34.7946L37.6296 30.7067C37.8771 30.2748 38.0008 29.7966 38.0008 29.3184H29.4951L31.305 32.8663L33.7483 36.6611Z"
        fill="#EA4335"
      />
      <path
        d="M24.4996 20.6807L28.7521 13.338C28.3346 13.0912 27.8552 12.9678 27.3604 12.9678H21.6388C21.144 12.9678 20.6646 13.1066 20.2471 13.338L24.4996 20.6807Z"
        fill="#00832D"
      />
      <path
        d="M29.494 29.3184H19.5045L15.252 36.6611C15.6695 36.9079 16.1488 37.0313 16.6437 37.0313H32.3548C32.8497 37.0313 33.329 36.8925 33.7465 36.6611L29.494 29.3184Z"
        fill="#2684FC"
      />
      <g filter={`url(#filter1_i_${idJitter})`}>
        <path
          d="M33.7009 21.1434L29.7731 14.356C29.5257 13.9241 29.17 13.5847 28.7525 13.3379L24.5 20.6806L29.4948 29.3191H37.9844C37.9844 28.8409 37.8606 28.3627 37.6132 27.9308L33.7009 21.1434Z"
          fill="#FFBA00"
        />
      </g>
      <defs>
        <filter
          id={`filter0_i_${idJitter}`}
          x="11"
          y="13.3389"
          width="13.4998"
          height="17.9814"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="2" />
          <feGaussianBlur stdDeviation="2" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.25 0" />
          <feBlend mode="normal" in2="shape" result={`effect1_innerShadow_${idJitter}`} />
        </filter>
        <filter
          id={`filter1_i_${idJitter}`}
          x="24.5"
          y="13.3379"
          width="13.4844"
          height="15.9814"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="2" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.25 0" />
          <feBlend mode="normal" in2="shape" result={`effect1_innerShadow_${idJitter}`} />
        </filter>
        <linearGradient
          id={`paint0_linear_${idJitter}`}
          x1="25"
          y1="6.5"
          x2="25"
          y2="50"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="#D9D9D9" />
        </linearGradient>
      </defs>
    </svg>
  );
};

const GoogleDocsTile = (props: React.ComponentPropsWithoutRef<"svg">) => {
  const idJitter = React.useId();

  return (
    <svg
      width="50"
      height="50"
      viewBox="0 0 50 50"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g clipPath={`url(#clip0_${idJitter})`}>
        <rect width="50" height="50" fill="#171717" />
        <rect width="50" height="50" fill={`url(#paint0_linear_${idJitter})`} />
        <path
          d="M27.9181 9.08984H15.5139C14.31 9.08984 13.325 10.0661 13.325 11.2594V38.74C13.325 39.9332 14.31 40.9095 15.5139 40.9095H34.485C35.689 40.9095 36.674 39.9332 36.674 38.74V17.7679L31.5664 14.1521L27.9181 9.08984Z"
          fill={`url(#paint1_linear_${idJitter})`}
        />
        <path
          d="M28.5593 17.1338L36.675 25.1755V17.7684L28.5593 17.1338Z"
          fill={`url(#paint2_linear_${idJitter})`}
        />
        <g filter={`url(#filter0_dddd_${idJitter})`}>
          <path
            d="M19.1626 31.5086C19.1626 31.908 19.4864 32.2317 19.8858 32.2317H30.114C30.5134 32.2317 30.8371 31.908 30.8371 31.5086V31.5086C30.8371 31.1092 30.5134 30.7854 30.114 30.7854H19.8858C19.4864 30.7854 19.1626 31.1092 19.1626 31.5086V31.5086ZM19.1626 34.4013C19.1626 34.8007 19.4864 35.1244 19.8858 35.1244H27.1953C27.5947 35.1244 27.9185 34.8007 27.9185 34.4013V34.4013C27.9185 34.0019 27.5947 33.6781 27.1953 33.6781H19.8858C19.4864 33.6781 19.1626 34.0019 19.1626 34.4013V34.4013ZM19.8858 25C19.4864 25 19.1626 25.3238 19.1626 25.7232V25.7232C19.1626 26.1226 19.4864 26.4463 19.8858 26.4463H30.114C30.5134 26.4463 30.8371 26.1226 30.8371 25.7232V25.7232C30.8371 25.3238 30.5134 25 30.114 25H19.8858ZM19.1626 28.6159C19.1626 29.0153 19.4864 29.339 19.8858 29.339H30.114C30.5134 29.339 30.8371 29.0153 30.8371 28.6159V28.6159C30.8371 28.2165 30.5134 27.8927 30.114 27.8927H19.8858C19.4864 27.8927 19.1626 28.2165 19.1626 28.6159V28.6159Z"
            fill={`url(#paint3_linear_${idJitter})`}
          />
        </g>
        <path
          d="M27.9192 9.08984V15.5984C27.9192 16.7971 28.8988 17.7679 30.1082 17.7679H36.6751L27.9192 9.08984Z"
          fill="#A1C2FA"
        />
        <path
          d="M15.5139 9.08984C14.31 9.08984 13.325 10.0661 13.325 11.2594V11.4402C13.325 10.2469 14.31 9.27064 15.5139 9.27064H27.9181V9.08984H15.5139Z"
          fill="white"
          fillOpacity="0.2"
        />
        <path
          d="M34.485 40.7281H15.5139C14.31 40.7281 13.325 39.7518 13.325 38.5586V38.7394C13.325 39.9326 14.31 40.9089 15.5139 40.9089H34.485C35.689 40.9089 36.674 39.9326 36.674 38.7394V38.5586C36.674 39.7518 35.689 40.7281 34.485 40.7281Z"
          fill="#1A237E"
          fillOpacity="0.2"
        />
        <path
          d="M30.1074 17.7672C28.898 17.7672 27.9185 16.7963 27.9185 15.5977V15.7785C27.9185 16.9771 28.898 17.948 30.1074 17.948H36.6744V17.7672H30.1074Z"
          fill="#1A237E"
          fillOpacity="0.1"
        />
      </g>
      <defs>
        <filter
          id={`filter0_dddd_${idJitter}`}
          x="15.1626"
          y="24"
          width="19.6746"
          height="26.124"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="1" />
          <feGaussianBlur stdDeviation="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.1 0" />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result={`effect1_dropShadow_${idJitter}`}
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="3" />
          <feGaussianBlur stdDeviation="1.5" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.09 0" />
          <feBlend
            mode="normal"
            in2={`effect1_dropShadow_${idJitter}`}
            result={`effect2_dropShadow_${idJitter}`}
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="6" />
          <feGaussianBlur stdDeviation="2" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.05 0" />
          <feBlend
            mode="normal"
            in2={`effect2_dropShadow_${idJitter}`}
            result={`effect3_dropShadow_${idJitter}`}
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="11" />
          <feGaussianBlur stdDeviation="2" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.01 0" />
          <feBlend
            mode="normal"
            in2={`effect3_dropShadow_${idJitter}`}
            result={`effect4_dropShadow_${idJitter}`}
          />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2={`effect4_dropShadow_${idJitter}`}
            result="shape"
          />
        </filter>
        <linearGradient
          id={`paint0_linear_${idJitter}`}
          x1="25"
          y1="6.5"
          x2="25"
          y2="50"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="#D9D9D9" />
        </linearGradient>
        <linearGradient
          id={`paint1_linear_${idJitter}`}
          x1="24.9995"
          y1="13.6349"
          x2="24.9995"
          y2="40.9095"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#4285F4" />
          <stop offset="1" stopColor="#1F6CED" />
        </linearGradient>
        <linearGradient
          id={`paint2_linear_${idJitter}`}
          x1="434.384"
          y1="86.1806"
          x2="434.384"
          y2="821.415"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#1A237E" stopOpacity="0.2" />
          <stop offset="1" stopColor="#1A237E" stopOpacity="0.02" />
        </linearGradient>
        <linearGradient
          id={`paint3_linear_${idJitter}`}
          x1="24.9999"
          y1="25"
          x2="24.9999"
          y2="35.1244"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#F1F1F1" />
          <stop offset="1" stopColor="#F1F1F1" stopOpacity="0.5" />
        </linearGradient>
        <clipPath id={`clip0_${idJitter}`}>
          <rect width="50" height="50" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
};

const GoogleSheetsTile = (props: React.ComponentPropsWithoutRef<"svg">) => {
  const idJitter = React.useId();
  return (
    <svg
      width="50"
      height="50"
      viewBox="0 0 50 50"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect width="50" height="50" fill="#171717" />
      <rect width="50" height="50" fill={`url(#paint0_linear_${idJitter})`} />
      <g filter={`url(#filter0_i_${idJitter})`}>
        <path
          d="M27.75 9.9502H16.0625C14.9281 9.9502 14 10.8737 14 12.0024V37.9975C14 39.1262 14.9281 40.0497 16.0625 40.0497H33.9375C35.0719 40.0497 36 39.1262 36 37.9975V18.1592L31.1875 14.7388L27.75 9.9502Z"
          fill={`url(#paint1_linear_${idJitter})`}
        />
      </g>
      <g filter={`url(#filter1_dddd_${idJitter})`}>
        <path
          d="M20.5149 24.6582C19.9544 24.6582 19.5 25.1126 19.5 25.6731V33.5625C19.5 34.123 19.9544 34.5774 20.5149 34.5774H29.4851C30.0456 34.5774 30.5 34.123 30.5 33.5625V25.6731C30.5 25.1126 30.0456 24.6582 29.4851 24.6582H20.5149ZM24.3125 33.2092H20.875V31.499H24.3125V33.2092ZM24.3125 30.4729H20.875V28.7627H24.3125V30.4729ZM24.3125 27.7366H20.875V26.0264H24.3125V27.7366ZM29.125 33.2092H25.6875V31.499H29.125V33.2092ZM29.125 30.4729H25.6875V28.7627H29.125V30.4729ZM29.125 27.7366H25.6875V26.0264H29.125V27.7366Z"
          fill={`url(#paint2_linear_${idJitter})`}
        />
      </g>
      <path
        d="M27.75 9.9502V16.1069C27.75 17.2408 28.673 18.1591 29.8125 18.1591H36L27.75 9.9502Z"
        fill="#87CEAC"
      />
      <path
        d="M16.0625 9.9502C14.9281 9.9502 14 10.8737 14 12.0024V12.1735C14 11.0447 14.9281 10.1212 16.0625 10.1212H27.75V9.9502H16.0625Z"
        fill="white"
        fillOpacity="0.2"
      />
      <path
        d="M29.812 18.1587C28.6725 18.1587 27.7495 17.2403 27.7495 16.1064V16.2775C27.7495 17.4113 28.6725 18.3297 29.812 18.3297H35.9995V18.1587H29.812Z"
        fill="#263238"
        fillOpacity="0.1"
      />
      <defs>
        <filter
          id={`filter0_i_${idJitter}`}
          x="14"
          y="9.9502"
          width="22"
          height="30.0996"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="1.52233" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.02 0" />
          <feBlend mode="normal" in2="shape" result={`effect1_innerShadow_${idJitter}`} />
        </filter>
        <filter
          id={`filter1_dddd_${idJitter}`}
          x="17.5"
          y="23.6582"
          width="15"
          height="17.9189"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="0.5" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.1 0" />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result={`effect1_dropShadow_${idJitter}`}
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="1" />
          <feGaussianBlur stdDeviation="0.5" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.09 0" />
          <feBlend
            mode="normal"
            in2={`effect1_dropShadow_${idJitter}`}
            result={`effect2_dropShadow_${idJitter}`}
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="3" />
          <feGaussianBlur stdDeviation="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.05 0" />
          <feBlend
            mode="normal"
            in2={`effect2_dropShadow_${idJitter}`}
            result={`effect3_dropShadow_${idJitter}`}
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="5" />
          <feGaussianBlur stdDeviation="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.01 0" />
          <feBlend
            mode="normal"
            in2={`effect3_dropShadow_${idJitter}`}
            result={`effect4_dropShadow_${idJitter}`}
          />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2={`effect4_dropShadow_${idJitter}`}
            result="shape"
          />
        </filter>
        <linearGradient
          id={`paint0_linear_${idJitter}`}
          x1="25"
          y1="6.5"
          x2="25"
          y2="50"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="#D9D9D9" />
        </linearGradient>
        <linearGradient
          id={`paint1_linear_${idJitter}`}
          x1="25"
          y1="9.9502"
          x2="25"
          y2="40.0497"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#30BC78" />
          <stop offset="1" stopColor="#0B9F57" />
        </linearGradient>
        <linearGradient
          id={`paint2_linear_${idJitter}`}
          x1="25"
          y1="24.6582"
          x2="25"
          y2="34.5774"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FDFFFF" />
          <stop offset="1" stopColor="#FDFFFF" stopOpacity="0.6" />
        </linearGradient>
      </defs>
    </svg>
  );
};

const GoogleSlidesTile = (props: React.ComponentPropsWithoutRef<"svg">) => {
  const idJitter = React.useId();

  return (
    <svg
      width="50"
      height="50"
      viewBox="0 0 50 50"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect width="50" height="50" fill="#171717" />
      <rect width="50" height="50" fill={`url(#paint0_linear_${idJitter})`} />
      <path
        d="M33.9375 40.0497H16.0625C14.9281 40.0497 14 39.1262 14 37.9975V12.0024C14 10.8737 14.9281 9.9502 16.0625 9.9502H28.4375L36 17.4751V37.9975C36 39.1262 35.0719 40.0497 33.9375 40.0497Z"
        fill={`url(#paint1_linear_${idJitter})`}
      />
      <g filter={`url(#filter0_dddd_${idJitter})`}>
        <path
          d="M19.126 21.751C18.5737 21.751 18.126 22.1987 18.126 22.751V30.3281C18.126 30.8804 18.5737 31.3281 19.126 31.3281H30.876C31.4283 31.3281 31.876 30.8804 31.876 30.3281V22.751C31.876 22.1987 31.4283 21.751 30.876 21.751H19.126ZM30.1572 29.5179C30.1572 29.5731 30.1125 29.6179 30.0572 29.6179H19.9447C19.8895 29.6179 19.8447 29.5731 19.8447 29.5179V23.5612C19.8447 23.5059 19.8895 23.4612 19.9447 23.4612H30.0572C30.1125 23.4612 30.1572 23.5059 30.1572 23.5612V29.5179Z"
          fill={`url(#paint2_linear_${idJitter})`}
        />
      </g>
      <path
        d="M28.4375 9.9502L36 17.4751H30.4542C29.3404 17.4751 28.4375 16.5767 28.4375 15.4684V9.9502Z"
        fill={`url(#paint3_linear_${idJitter})`}
      />
      <defs>
        <filter
          id={`filter0_dddd_${idJitter}`}
          x="15.126"
          y="20.751"
          width="19.75"
          height="20.5771"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="0.5" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0.34902 0 0 0 0 0 0 0 0 0.21 0" />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result={`effect1_dropShadow_${idJitter}`}
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="2" />
          <feGaussianBlur stdDeviation="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0.34902 0 0 0 0 0 0 0 0 0.18 0" />
          <feBlend
            mode="normal"
            in2={`effect1_dropShadow_${idJitter}`}
            result={`effect2_dropShadow_${idJitter}`}
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="4" />
          <feGaussianBlur stdDeviation="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0.34902 0 0 0 0 0 0 0 0 0.11 0" />
          <feBlend
            mode="normal"
            in2={`effect2_dropShadow_${idJitter}`}
            result={`effect3_dropShadow_${idJitter}`}
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="7" />
          <feGaussianBlur stdDeviation="1.5" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0.34902 0 0 0 0 0 0 0 0 0.03 0" />
          <feBlend
            mode="normal"
            in2={`effect3_dropShadow_${idJitter}`}
            result={`effect4_dropShadow_${idJitter}`}
          />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2={`effect4_dropShadow_${idJitter}`}
            result="shape"
          />
        </filter>
        <linearGradient
          id={`paint0_linear_${idJitter}`}
          x1="25"
          y1="6.5"
          x2="25"
          y2="50"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="#D9D9D9" />
        </linearGradient>
        <linearGradient
          id={`paint1_linear_${idJitter}`}
          x1="25"
          y1="15.9203"
          x2="25"
          y2="40.0497"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#F8BF08" />
          <stop offset="1" stopColor="#F8B008" />
        </linearGradient>
        <linearGradient
          id={`paint2_linear_${idJitter}`}
          x1="25.001"
          y1="21.751"
          x2="25.001"
          y2="31.3281"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FDFFFF" />
          <stop offset="1" stopColor="#FDFFFF" stopOpacity="0.6" />
        </linearGradient>
        <linearGradient
          id={`paint3_linear_${idJitter}`}
          x1="32"
          y1="13.9303"
          x2="29.5165"
          y2="17.4246"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#F59307" />
          <stop offset="1" stopColor="#F59307" />
        </linearGradient>
      </defs>
    </svg>
  );
};

const GithubTile = (props: React.ComponentPropsWithoutRef<"svg">) => {
  const idJitter = React.useId();

  return (
    <svg
      width="50"
      height="50"
      viewBox="0 0 50 50"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g clipPath={`url(#clip0_${idJitter})`}>
        <rect width="50" height="50" fill={`url(#paint0_radial_${idJitter})`} />
        <g filter={`url(#filter0_ddddi_${idJitter})`}>
          <path
            d="M25.001 8.63984C34.025 8.63984 41.334 15.9489 41.334 24.9728C41.3317 31.9902 36.8552 38.2247 30.2077 40.4682C29.3911 40.6315 29.0842 40.1205 29.0842 39.6924C29.0842 39.1406 29.1052 37.3848 29.1052 35.2008C29.1052 33.6702 28.5954 32.6902 28.0028 32.1792C31.6368 31.7709 35.4553 30.3826 35.4553 24.1154C35.4553 22.3187 34.8218 20.8686 33.7811 19.7264C33.9445 19.3181 34.5161 17.644 33.6178 15.3982C33.6178 15.3982 32.2493 14.949 29.1262 17.0723C27.8196 16.7048 26.4313 16.5217 25.043 16.5217C23.6547 16.5217 22.2664 16.7048 20.9597 17.0723C17.8366 14.97 16.4681 15.3982 16.4681 15.3982C15.5698 17.644 16.1415 19.3181 16.3048 19.7264C15.2642 20.8698 14.6307 22.3397 14.6307 24.1154C14.6307 30.3627 18.4281 31.772 22.0622 32.1804C21.592 32.5887 21.1639 33.3038 21.0204 34.3643C20.0812 34.7936 17.7328 35.4878 16.264 33.0168C15.9572 32.5269 15.039 31.3229 13.7534 31.3427C12.3849 31.3637 13.2027 32.1185 13.7732 32.4242C14.4674 32.8115 15.263 34.2617 15.4473 34.7318C15.774 35.65 16.8356 37.4069 20.9387 36.6509C20.9387 38.0194 20.9597 39.3051 20.9597 39.6924C20.9597 40.1217 20.6529 40.6105 19.8362 40.4682C13.1642 38.2469 8.66447 32.0042 8.66797 24.9717C8.66797 15.9477 15.977 8.63984 25.001 8.63984Z"
            fill={`url(#paint1_linear_${idJitter})`}
          />
        </g>
      </g>
      <defs>
        <filter
          id={`filter0_ddddi_${idJitter}`}
          x="-0.665178"
          y="6.77302"
          width="51.3323"
          height="67.3258"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="1.86663" />
          <feGaussianBlur stdDeviation="1.86663" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.1 0" />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result={`effect1_dropShadow_${idJitter}`}
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="5.59989" />
          <feGaussianBlur stdDeviation="2.79994" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.09 0" />
          <feBlend
            mode="normal"
            in2={`effect1_dropShadow_${idJitter}`}
            result={`effect2_dropShadow_${idJitter}`}
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="13.0664" />
          <feGaussianBlur stdDeviation="3.73326" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.05 0" />
          <feBlend
            mode="normal"
            in2={`effect2_dropShadow_${idJitter}`}
            result={`effect3_dropShadow_${idJitter}`}
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="24.2662" />
          <feGaussianBlur stdDeviation="4.66657" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.01 0" />
          <feBlend
            mode="normal"
            in2={`effect3_dropShadow_${idJitter}`}
            result={`effect4_dropShadow_${idJitter}`}
          />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2={`effect4_dropShadow_${idJitter}`}
            result="shape"
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="0.746652" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0" />
          <feBlend mode="normal" in2="shape" result={`effect5_innerShadow_${idJitter}`} />
        </filter>
        <radialGradient
          id={`paint0_radial_${idJitter}`}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(25.333 50) rotate(-90) scale(50 167.578)"
        >
          <stop stopColor="#1D1D1D" />
          <stop offset="1" stopColor="#4F4D4D" />
        </radialGradient>
        <linearGradient
          id={`paint1_linear_${idJitter}`}
          x1="25.001"
          y1="8.63867"
          x2="26.5056"
          y2="43.4361"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="white" stopOpacity="0.5" />
        </linearGradient>
        <clipPath id={`clip0_${idJitter}`}>
          <rect width="50" height="50" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
};

const LinearTile = (props: React.ComponentPropsWithoutRef<"svg">) => {
  const idJitter = React.useId();

  return (
    <svg
      width="50"
      height="50"
      viewBox="0 0 50 50"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g clipPath={`url(#clip0_${idJitter})`}>
        <rect width="50" height="50" fill={`url(#paint0_radial_${idJitter})`} />
        <g filter={`url(#filter0_ddddi_${idJitter})`}>
          <path
            d="M11.1792 28.265C11.1162 27.9962 11.4364 27.8269 11.6315 28.0221L21.9767 38.3673C22.1719 38.5625 22.0026 38.8827 21.7339 38.8196C16.5133 37.5949 12.4039 33.4856 11.1792 28.265ZM10.8326 24.1187C10.8276 24.199 10.8577 24.2774 10.9146 24.3342L25.6646 39.0842C25.7215 39.1411 25.7999 39.1714 25.8801 39.1663C26.5514 39.1245 27.21 39.0359 27.8528 38.9039C28.0694 38.8595 28.1447 38.5933 27.9883 38.437L11.5619 22.0106C11.4055 21.8542 11.1394 21.9294 11.0949 22.1461C10.9629 22.7888 10.8744 23.4475 10.8326 24.1187ZM12.0251 19.25C11.978 19.3559 12.002 19.4797 12.084 19.5617L30.4372 37.9149C30.5192 37.9969 30.6429 38.0209 30.7488 37.9737C31.2549 37.7483 31.7453 37.4941 32.2181 37.2133C32.3745 37.1203 32.3986 36.9054 32.27 36.7767L13.2221 17.7289C13.0935 17.6002 12.8785 17.6244 12.7856 17.7808C12.5047 18.2535 12.2505 18.744 12.0251 19.25ZM14.4187 15.9545C14.3138 15.8496 14.3073 15.6814 14.4061 15.5708C17.0029 12.6636 20.7803 10.8335 24.9851 10.8335C32.8166 10.8335 39.1654 17.1822 39.1654 25.0138C39.1654 29.2186 37.3352 32.996 34.4281 35.5927C34.3175 35.6915 34.1493 35.6851 34.0444 35.5802L14.4187 15.9545Z"
            fill={`url(#paint1_linear_${idJitter})`}
          />
        </g>
      </g>
      <defs>
        <filter
          id={`filter0_ddddi_${idJitter}`}
          x="7.83203"
          y="10.8335"
          width="34.334"
          height="39.3335"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="1" />
          <feGaussianBlur stdDeviation="0.5" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.23 0" />
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_16327_4126" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="2" />
          <feGaussianBlur stdDeviation="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.2 0" />
          <feBlend
            mode="normal"
            in2="effect1_dropShadow_16327_4126"
            result="effect2_dropShadow_16327_4126"
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="5" />
          <feGaussianBlur stdDeviation="1.5" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.12 0" />
          <feBlend
            mode="normal"
            in2="effect2_dropShadow_16327_4126"
            result="effect3_dropShadow_16327_4126"
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="8" />
          <feGaussianBlur stdDeviation="1.5" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.03 0" />
          <feBlend
            mode="normal"
            in2="effect3_dropShadow_16327_4126"
            result="effect4_dropShadow_16327_4126"
          />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect4_dropShadow_16327_4126"
            result="shape"
          />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="1" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0" />
          <feBlend mode="normal" in2="shape" result="effect5_innerShadow_16327_4126" />
        </filter>
        <radialGradient
          id={`paint0_radial_${idJitter}`}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(25.333 50) rotate(-90) scale(50 167.578)"
        >
          <stop stopColor="#1D1D1D" />
          <stop offset="1" stopColor="#4F4D4D" />
        </radialGradient>
        <linearGradient
          id={`paint1_linear_${idJitter}`}
          x1="24.9987"
          y1="10.8335"
          x2="24.9987"
          y2="39.1668"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="white" stopOpacity="0.5" />
        </linearGradient>
        <clipPath id={`clip0_${idJitter}`}>
          <rect width="50" height="50" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
};

const SlackTile = (props: React.ComponentPropsWithoutRef<"svg">) => {
  const idJitter = React.useId();

  return (
    <svg
      width="50"
      height="50"
      viewBox="0 0 50 50"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect width="50" height="49.9986" fill="#171717" />
      <rect width="50" height="49.9986" fill={`url(#paint0_linear_${idJitter})`} />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M16.3154 28.9467C16.3154 30.6907 14.9017 32.1044 13.1577 32.1044C11.4137 32.1044 10 30.6907 10 28.9467C10 27.2028 11.4137 25.7891 13.1577 25.7891H16.3154V28.9467Z"
        fill="#E01E5A"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M17.8955 28.9467C17.8955 27.2028 19.3092 25.7891 21.0532 25.7891C22.7972 25.7891 24.2109 27.2028 24.2109 28.9467V36.841C24.2109 38.5849 22.7972 39.9987 21.0532 39.9987C19.3092 39.9987 17.8955 38.5849 17.8955 36.841V28.9467Z"
        fill="#E01E5A"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M21.0532 16.3154C19.3092 16.3154 17.8955 14.9017 17.8955 13.1577C17.8955 11.4137 19.3092 10 21.0532 10C22.7972 10 24.2109 11.4137 24.2109 13.1577V16.3154H21.0532Z"
        fill="#36C5F0"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M21.0519 17.8945C22.7959 17.8945 24.2096 19.3082 24.2096 21.0522C24.2096 22.7962 22.7959 24.2099 21.0519 24.2099H13.1577C11.4137 24.2099 10 22.7962 10 21.0522C10 19.3082 11.4137 17.8945 13.1577 17.8945H21.0519Z"
        fill="#36C5F0"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M33.6843 21.0522C33.6843 19.3082 35.098 17.8945 36.842 17.8945C38.586 17.8945 39.9997 19.3082 39.9997 21.0522C39.9997 22.7962 38.586 24.2099 36.842 24.2099H33.6843V21.0522Z"
        fill="#2EB67D"
      />
      <g filter={`url(#filter0_i_${idJitter})`}>
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M32.1042 21.0519C32.1042 22.7959 30.6905 24.2096 28.9465 24.2096C27.2025 24.2096 25.7888 22.7959 25.7888 21.0519V13.1577C25.7888 11.4137 27.2025 10 28.9465 10C30.6905 10 32.1042 11.4137 32.1042 13.1577V21.0519Z"
          fill={`url(#paint1_linear_${idJitter})`}
        />
      </g>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M28.9467 33.6826C30.6907 33.6826 32.1044 35.0964 32.1044 36.8403C32.1044 38.5843 30.6907 39.998 28.9467 39.998C27.2028 39.998 25.7891 38.5843 25.7891 36.8403V33.6826H28.9467Z"
        fill="#ECB22E"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M28.9465 32.1044C27.2025 32.1044 25.7888 30.6907 25.7888 28.9467C25.7888 27.2028 27.2025 25.7891 28.9465 25.7891H36.8407C38.5847 25.7891 39.9984 27.2028 39.9984 28.9467C39.9984 30.6907 38.5847 32.1044 36.8407 32.1044H28.9465Z"
        fill={`url(#paint2_linear_${idJitter})`}
      />
      <defs>
        <filter
          id={`filter0_i_${idJitter}`}
          x="25.7888"
          y="8.919"
          width="6.31543"
          height="15.291"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="-1.081" />
          <feGaussianBlur stdDeviation="0.5405" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.05 0" />
          <feBlend mode="plus-darker" in2="shape" result={`effect1_innerShadow_${idJitter}`} />
        </filter>
        <linearGradient
          id={`paint0_linear_${idJitter}`}
          x1="25"
          y1="6.49982"
          x2="25"
          y2="49.9987"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="#D9D9D9" />
        </linearGradient>
        <linearGradient
          id={`paint1_linear_${idJitter}`}
          x1="28.9465"
          y1="10"
          x2="28.9465"
          y2="24.2096"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#37D492" />
          <stop offset="1" stopColor="#2EB67D" />
        </linearGradient>
        <linearGradient
          id={`paint2_linear_${idJitter}`}
          x1="32.8936"
          y1="25.7891"
          x2="32.8936"
          y2="32.1044"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFCC58" />
          <stop offset="1" stopColor="#ECAA2E" />
        </linearGradient>
      </defs>
    </svg>
  );
};

export type IntegrationTileSlug =
  | "gmail"
  | "google_calendar"
  | "google_drive"
  | "google_docs"
  | "google_sheets"
  | "google_slides"
  | "github"
  | "linear"
  | "slack";

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
  slack: SlackTile,
};
