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
        d="M12.91 35.72H17.36V24.68L11 19.81V33.77C11 34.85 11.86 35.72 12.91 35.72Z"
        fill="#4285F4"
      />
      <path d="M32.64 35.72H37.09C38.15 35.72 39 34.84 39 33.77V19.81L32.64 24.68" fill="#34A853" />
      <path d="M32.64 16.24V24.68L39 19.81V17.21C39 14.8 36.31 13.43 34.42 14.87" fill="#FBBC04" />
      <path d="M17.36 24.68V16.24L25 22.08L32.64 16.24V24.68L25 30.52" fill="#EA4335" />
      <path
        d="M11 17.21V19.81L17.36 24.68V16.24L15.58 14.87C13.69 13.43 11 14.8 11 17.21Z"
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
      <rect width="50" height="50" fill="#171717" />
      <rect width="50" height="50" fill={`url(#${idJitter})`} />
      <path
        d="M32.37 17.63L25.74 16.89L17.63 17.63L16.9 25L17.63 32.37L25 33.29L32.37 32.37L33.11 24.82L32.37 17.63Z"
        fill="white"
      />
      <path
        d="M20.65 29.06C20.1 28.69 19.72 28.15 19.51 27.43L20.79 26.9C20.91 27.34 21.11 27.69 21.4 27.93C21.69 28.17 22.04 28.29 22.45 28.29C22.86 28.29 23.22 28.17 23.52 27.91C23.82 27.66 23.98 27.33 23.98 26.94C23.98 26.54 23.82 26.21 23.5 25.96C23.18 25.7 22.79 25.58 22.31 25.58H21.57V24.31H22.23C22.64 24.31 22.99 24.2 23.27 23.98C23.55 23.76 23.69 23.46 23.69 23.07C23.69 22.73 23.56 22.46 23.31 22.25C23.06 22.05 22.74 21.94 22.36 21.94C21.98 21.94 21.69 22.04 21.46 22.24C21.24 22.44 21.08 22.69 20.98 22.98L19.72 22.46C19.88 21.98 20.19 21.56 20.64 21.2C21.09 20.83 21.67 20.65 22.37 20.65C22.89 20.65 23.35 20.75 23.77 20.95C24.18 21.15 24.5 21.43 24.74 21.79C24.97 22.14 25.09 22.54 25.09 22.98C25.09 23.43 24.98 23.81 24.76 24.13C24.54 24.44 24.28 24.68 23.96 24.85V24.92C24.38 25.1 24.72 25.36 24.99 25.72C25.26 26.08 25.39 26.51 25.39 27.01C25.39 27.51 25.26 27.96 25.01 28.35C24.75 28.75 24.4 29.06 23.96 29.28C23.51 29.51 23.01 29.62 22.45 29.62C21.8 29.62 21.2 29.44 20.65 29.06Z"
        fill="#1A73E8"
      />
      <path
        d="M28.5 22.72L27.1 23.73L26.4 22.67L28.92 20.85H29.89V29.42H28.5V22.72Z"
        fill="#1A73E8"
      />
      <path d="M32.37 39L39 32.37L35.68 30.89L32.37 32.37L30.9 35.68L32.37 39Z" fill="#EA4335" />
      <path d="M16.16 35.68L17.63 39H32.37V32.37H17.63L16.16 35.68Z" fill="#34A853" />
      <path
        d="M13.21 11C11.99 11 11 11.99 11 13.21V32.37L14.32 33.84L17.63 32.37V17.63H32.37L33.84 14.32L32.37 11H13.21Z"
        fill="#4285F4"
      />
      <path d="M11 32.37V36.79C11 38.01 11.99 39 13.21 39H17.63V32.37H11Z" fill="#188038" />
      <path d="M32.37 17.63V32.37H39V17.63L35.68 16.16L32.37 17.63Z" fill="#FBBC04" />
      <path d="M39 17.63V13.21C39 11.99 38.01 11 36.79 11H32.37V17.63H39Z" fill="#1967D2" />
      <defs>
        <linearGradient
          id={`${idJitter}`}
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
        d="M13.04 33.59L14.23 35.64C14.48 36.07 14.84 36.41 15.25 36.66L19.5 29.32H11C11 29.8 11.12 30.27 11.37 30.71L13.04 33.59Z"
        fill="#0066DA"
      />
      <g filter={`url(#filter0_i_${idJitter})`}>
        <path
          d="M24.5 20.68L20.25 13.34C19.83 13.59 19.47 13.93 19.23 14.36L11.37 27.93C11.13 28.35 11 28.83 11 29.32H19.5L24.5 20.68Z"
          fill="#00AC47"
        />
      </g>
      <path
        d="M33.75 36.66C34.17 36.41 34.52 36.07 34.77 35.64L35.26 34.79L37.63 30.71C37.88 30.27 38 29.8 38 29.32H29.5L31.3 32.87L33.75 36.66Z"
        fill="#EA4335"
      />
      <path
        d="M24.5 20.68L28.75 13.34C28.33 13.09 27.86 12.97 27.36 12.97H21.64C21.14 12.97 20.66 13.11 20.25 13.34L24.5 20.68Z"
        fill="#00832D"
      />
      <path
        d="M29.49 29.32H19.5L15.25 36.66C15.67 36.91 16.15 37.03 16.64 37.03H32.35C32.85 37.03 33.33 36.89 33.75 36.66L29.49 29.32Z"
        fill="#2684FC"
      />
      <g filter={`url(#filter1_i_${idJitter})`}>
        <path
          d="M33.7 21.14L29.77 14.36C29.53 13.92 29.17 13.58 28.75 13.34L24.5 20.68L29.49 29.32H37.98C37.98 28.84 37.86 28.36 37.61 27.93L33.7 21.14Z"
          fill="#FFBA00"
        />
      </g>
      <defs>
        <filter
          id={`filter0_i_${idJitter}`}
          x="11"
          y="13.34"
          width="13.5"
          height="17.98"
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
          y="13.34"
          width="13.48"
          height="15.98"
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
          d="M27.92 9.09H15.51C14.31 9.09 13.32 10.07 13.32 11.26V38.74C13.32 39.93 14.31 40.91 15.51 40.91H34.48C35.69 40.91 36.67 39.93 36.67 38.74V17.77L31.57 14.15L27.92 9.09Z"
          fill={`url(#paint1_linear_${idJitter})`}
        />
        <path
          d="M28.56 17.13L36.67 25.18V17.77L28.56 17.13Z"
          fill={`url(#paint2_linear_${idJitter})`}
        />
        <g filter={`url(#filter0_dddd_${idJitter})`}>
          <path
            d="M19.16 31.51C19.16 31.91 19.49 32.23 19.89 32.23H30.11C30.51 32.23 30.84 31.91 30.84 31.51V31.51C30.84 31.11 30.51 30.79 30.11 30.79H19.89C19.49 30.79 19.16 31.11 19.16 31.51V31.51ZM19.16 34.4C19.16 34.8 19.49 35.12 19.89 35.12H27.2C27.59 35.12 27.92 34.8 27.92 34.4V34.4C27.92 34 27.59 33.68 27.2 33.68H19.89C19.49 33.68 19.16 34 19.16 34.4V34.4ZM19.89 25C19.49 25 19.16 25.32 19.16 25.72V25.72C19.16 26.12 19.49 26.45 19.89 26.45H30.11C30.51 26.45 30.84 26.12 30.84 25.72V25.72C30.84 25.32 30.51 25 30.11 25H19.89ZM19.16 28.62C19.16 29.02 19.49 29.34 19.89 29.34H30.11C30.51 29.34 30.84 29.02 30.84 28.62V28.62C30.84 28.22 30.51 27.89 30.11 27.89H19.89C19.49 27.89 19.16 28.22 19.16 28.62V28.62Z"
            fill={`url(#paint3_linear_${idJitter})`}
          />
        </g>
        <path
          d="M27.92 9.09V15.6C27.92 16.8 28.9 17.77 30.11 17.77H36.68L27.92 9.09Z"
          fill="#A1C2FA"
        />
        <path
          d="M15.51 9.09C14.31 9.09 13.32 10.07 13.32 11.26V11.44C13.32 10.25 14.31 9.27 15.51 9.27H27.92V9.09H15.51Z"
          fill="white"
          fillOpacity="0.2"
        />
        <path
          d="M34.48 40.73H15.51C14.31 40.73 13.32 39.75 13.32 38.56V38.74C13.32 39.93 14.31 40.91 15.51 40.91H34.48C35.69 40.91 36.67 39.93 36.67 38.74V38.56C36.67 39.75 35.69 40.73 34.48 40.73Z"
          fill="#1A237E"
          fillOpacity="0.2"
        />
        <path
          d="M30.11 17.77C28.9 17.77 27.92 16.8 27.92 15.6V15.78C27.92 16.98 28.9 17.95 30.11 17.95H36.67V17.77H30.11Z"
          fill="#1A237E"
          fillOpacity="0.1"
        />
      </g>
      <defs>
        <filter
          id={`filter0_dddd_${idJitter}`}
          x="15.16"
          y="24"
          width="19.67"
          height="26.12"
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
          x1="25"
          y1="13.63"
          x2="25"
          y2="40.91"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#4285F4" />
          <stop offset="1" stopColor="#1F6CED" />
        </linearGradient>
        <linearGradient
          id={`paint2_linear_${idJitter}`}
          x1="434.38"
          y1="86.18"
          x2="434.38"
          y2="821.41"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#1A237E" stopOpacity="0.2" />
          <stop offset="1" stopColor="#1A237E" stopOpacity="0.02" />
        </linearGradient>
        <linearGradient
          id={`paint3_linear_${idJitter}`}
          x1="25"
          y1="25"
          x2="25"
          y2="35.12"
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
          d="M27.75 9.95H16.06C14.93 9.95 14 10.87 14 12V38C14 39.13 14.93 40.05 16.06 40.05H33.94C35.07 40.05 36 39.13 36 38V18.16L31.19 14.74L27.75 9.95Z"
          fill={`url(#paint1_linear_${idJitter})`}
        />
      </g>
      <g filter={`url(#filter1_dddd_${idJitter})`}>
        <path
          d="M20.51 24.66C19.95 24.66 19.5 25.11 19.5 25.67V33.56C19.5 34.12 19.95 34.58 20.51 34.58H29.49C30.05 34.58 30.5 34.12 30.5 33.56V25.67C30.5 25.11 30.05 24.66 29.49 24.66H20.51ZM24.31 33.21H20.88V31.5H24.31V33.21ZM24.31 30.47H20.88V28.76H24.31V30.47ZM24.31 27.74H20.88V26.03H24.31V27.74ZM29.13 33.21H25.69V31.5H29.13V33.21ZM29.13 30.47H25.69V28.76H29.13V30.47ZM29.13 27.74H25.69V26.03H29.13V27.74Z"
          fill={`url(#paint2_linear_${idJitter})`}
        />
      </g>
      <path
        d="M27.75 9.95V16.11C27.75 17.24 28.67 18.16 29.81 18.16H36L27.75 9.95Z"
        fill="#87CEAC"
      />
      <path
        d="M16.06 9.95C14.93 9.95 14 10.87 14 12V12.17C14 11.04 14.93 10.12 16.06 10.12H27.75V9.95H16.06Z"
        fill="white"
        fillOpacity="0.2"
      />
      <path
        d="M29.81 18.16C28.67 18.16 27.75 17.24 27.75 16.11V16.28C27.75 17.41 28.67 18.33 29.81 18.33H36V18.16H29.81Z"
        fill="#263238"
        fillOpacity="0.1"
      />
      <defs>
        <filter
          id={`filter0_i_${idJitter}`}
          x="14"
          y="9.95"
          width="22"
          height="30.1"
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
          <feGaussianBlur stdDeviation="1.52" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.02 0" />
          <feBlend mode="normal" in2="shape" result={`effect1_innerShadow_${idJitter}`} />
        </filter>
        <filter
          id={`filter1_dddd_${idJitter}`}
          x="17.5"
          y="23.66"
          width="15"
          height="17.92"
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
          y1="9.95"
          x2="25"
          y2="40.05"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#30BC78" />
          <stop offset="1" stopColor="#0B9F57" />
        </linearGradient>
        <linearGradient
          id={`paint2_linear_${idJitter}`}
          x1="25"
          y1="24.66"
          x2="25"
          y2="34.58"
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
        d="M33.94 40.05H16.06C14.93 40.05 14 39.13 14 38V12C14 10.87 14.93 9.95 16.06 9.95H28.44L36 17.48V38C36 39.13 35.07 40.05 33.94 40.05Z"
        fill={`url(#paint1_linear_${idJitter})`}
      />
      <g filter={`url(#filter0_dddd_${idJitter})`}>
        <path
          d="M19.13 21.75C18.57 21.75 18.13 22.2 18.13 22.75V30.33C18.13 30.88 18.57 31.33 19.13 31.33H30.88C31.43 31.33 31.88 30.88 31.88 30.33V22.75C31.88 22.2 31.43 21.75 30.88 21.75H19.13ZM30.16 29.52C30.16 29.57 30.11 29.62 30.06 29.62H19.94C19.89 29.62 19.84 29.57 19.84 29.52V23.56C19.84 23.51 19.89 23.46 19.94 23.46H30.06C30.11 23.46 30.16 23.51 30.16 23.56V29.52Z"
          fill={`url(#paint2_linear_${idJitter})`}
        />
      </g>
      <path
        d="M28.44 9.95L36 17.48H30.45C29.34 17.48 28.44 16.58 28.44 15.47V9.95Z"
        fill={`url(#paint3_linear_${idJitter})`}
      />
      <defs>
        <filter
          id={`filter0_dddd_${idJitter}`}
          x="15.13"
          y="20.75"
          width="19.75"
          height="20.58"
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
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0.35 0 0 0 0 0 0 0 0 0.21 0" />
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
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0.35 0 0 0 0 0 0 0 0 0.18 0" />
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
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0.35 0 0 0 0 0 0 0 0 0.11 0" />
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
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0.35 0 0 0 0 0 0 0 0 0.03 0" />
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
          y1="15.92"
          x2="25"
          y2="40.05"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#F8BF08" />
          <stop offset="1" stopColor="#F8B008" />
        </linearGradient>
        <linearGradient
          id={`paint2_linear_${idJitter}`}
          x1="25"
          y1="21.75"
          x2="25"
          y2="31.33"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FDFFFF" />
          <stop offset="1" stopColor="#FDFFFF" stopOpacity="0.6" />
        </linearGradient>
        <linearGradient
          id={`paint3_linear_${idJitter}`}
          x1="32"
          y1="13.93"
          x2="29.52"
          y2="17.42"
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
            d="M25 8.64C34.02 8.64 41.33 15.95 41.33 24.97C41.33 31.99 36.86 38.22 30.21 40.47C29.39 40.63 29.08 40.12 29.08 39.69C29.08 39.14 29.11 37.38 29.11 35.2C29.11 33.67 28.6 32.69 28 32.18C31.64 31.77 35.46 30.38 35.46 24.12C35.46 22.32 34.82 20.87 33.78 19.73C33.94 19.32 34.52 17.64 33.62 15.4C33.62 15.4 32.25 14.95 29.13 17.07C27.82 16.7 26.43 16.52 25.04 16.52C23.65 16.52 22.27 16.7 20.96 17.07C17.84 14.97 16.47 15.4 16.47 15.4C15.57 17.64 16.14 19.32 16.3 19.73C15.26 20.87 14.63 22.34 14.63 24.12C14.63 30.36 18.43 31.77 22.06 32.18C21.59 32.59 21.16 33.3 21.02 34.36C20.08 34.79 17.73 35.49 16.26 33.02C15.96 32.53 15.04 31.32 13.75 31.34C12.38 31.36 13.2 32.12 13.77 32.42C14.47 32.81 15.26 34.26 15.45 34.73C15.77 35.65 16.84 37.41 20.94 36.65C20.94 38.02 20.96 39.31 20.96 39.69C20.96 40.12 20.65 40.61 19.84 40.47C13.16 38.25 8.66 32 8.67 24.97C8.67 15.95 15.98 8.64 25 8.64Z"
            fill={`url(#paint1_linear_${idJitter})`}
          />
        </g>
      </g>
      <defs>
        <filter
          id={`filter0_ddddi_${idJitter}`}
          x="-0.67"
          y="6.77"
          width="51.33"
          height="67.33"
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
          <feOffset dy="1.87" />
          <feGaussianBlur stdDeviation="1.87" />
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
          <feOffset dy="5.6" />
          <feGaussianBlur stdDeviation="2.8" />
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
          <feOffset dy="13.07" />
          <feGaussianBlur stdDeviation="3.73" />
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
          <feOffset dy="24.27" />
          <feGaussianBlur stdDeviation="4.67" />
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
          <feGaussianBlur stdDeviation="0.75" />
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
          gradientTransform="translate(25.33 50) rotate(-90) scale(50 167.58)"
        >
          <stop stopColor="#1D1D1D" />
          <stop offset="1" stopColor="#4F4D4D" />
        </radialGradient>
        <linearGradient
          id={`paint1_linear_${idJitter}`}
          x1="25"
          y1="8.64"
          x2="26.51"
          y2="43.44"
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
            d="M11.18 28.27C11.12 28 11.44 27.83 11.63 28.02L21.98 38.37C22.17 38.56 22 38.88 21.73 38.82C16.51 37.59 12.4 33.49 11.18 28.27ZM10.83 24.12C10.83 24.2 10.86 24.28 10.91 24.33L25.66 39.08C25.72 39.14 25.8 39.17 25.88 39.17C26.55 39.12 27.21 39.04 27.85 38.9C28.07 38.86 28.14 38.59 27.99 38.44L11.56 22.01C11.41 21.85 11.14 21.93 11.09 22.15C10.96 22.79 10.87 23.45 10.83 24.12ZM12.03 19.25C11.98 19.36 12 19.48 12.08 19.56L30.44 37.91C30.52 38 30.64 38.02 30.75 37.97C31.25 37.75 31.75 37.49 32.22 37.21C32.37 37.12 32.4 36.91 32.27 36.78L13.22 17.73C13.09 17.6 12.88 17.62 12.79 17.78C12.5 18.25 12.25 18.74 12.03 19.25ZM14.42 15.95C14.31 15.85 14.31 15.68 14.41 15.57C17 12.66 20.78 10.83 24.99 10.83C32.82 10.83 39.17 17.18 39.17 25.01C39.17 29.22 37.34 33 34.43 35.59C34.32 35.69 34.15 35.69 34.04 35.58L14.42 15.95Z"
            fill={`url(#paint1_linear_${idJitter})`}
          />
        </g>
      </g>
      <defs>
        <filter
          id={`filter0_ddddi_${idJitter}`}
          x="7.83"
          y="10.83"
          width="34.33"
          height="39.33"
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
          gradientTransform="translate(25.33 50) rotate(-90) scale(50 167.58)"
        >
          <stop stopColor="#1D1D1D" />
          <stop offset="1" stopColor="#4F4D4D" />
        </radialGradient>
        <linearGradient
          id={`paint1_linear_${idJitter}`}
          x1="25"
          y1="10.83"
          x2="25"
          y2="39.17"
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
      <rect width="50" height="50" fill="#171717" />
      <rect width="50" height="50" fill={`url(#paint0_linear_${idJitter})`} />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M16.32 28.95C16.32 30.69 14.9 32.1 13.16 32.1C11.41 32.1 10 30.69 10 28.95C10 27.2 11.41 25.79 13.16 25.79H16.32V28.95Z"
        fill="#E01E5A"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M17.9 28.95C17.9 27.2 19.31 25.79 21.05 25.79C22.8 25.79 24.21 27.2 24.21 28.95V36.84C24.21 38.58 22.8 40 21.05 40C19.31 40 17.9 38.58 17.9 36.84V28.95Z"
        fill="#E01E5A"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M21.05 16.32C19.31 16.32 17.9 14.9 17.9 13.16C17.9 11.41 19.31 10 21.05 10C22.8 10 24.21 11.41 24.21 13.16V16.32H21.05Z"
        fill="#36C5F0"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M21.05 17.89C22.8 17.89 24.21 19.31 24.21 21.05C24.21 22.8 22.8 24.21 21.05 24.21H13.16C11.41 24.21 10 22.8 10 21.05C10 19.31 11.41 17.89 13.16 17.89H21.05Z"
        fill="#36C5F0"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M33.68 21.05C33.68 19.31 35.1 17.89 36.84 17.89C38.59 17.89 40 19.31 40 21.05C40 22.8 38.59 24.21 36.84 24.21H33.68V21.05Z"
        fill="#2EB67D"
      />
      <g filter={`url(#filter0_i_${idJitter})`}>
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M32.1 21.05C32.1 22.8 30.69 24.21 28.95 24.21C27.2 24.21 25.79 22.8 25.79 21.05V13.16C25.79 11.41 27.2 10 28.95 10C30.69 10 32.1 11.41 32.1 13.16V21.05Z"
          fill={`url(#paint1_linear_${idJitter})`}
        />
      </g>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M28.95 33.68C30.69 33.68 32.1 35.1 32.1 36.84C32.1 38.58 30.69 40 28.95 40C27.2 40 25.79 38.58 25.79 36.84V33.68H28.95Z"
        fill="#ECB22E"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M28.95 32.1C27.2 32.1 25.79 30.69 25.79 28.95C25.79 27.2 27.2 25.79 28.95 25.79H36.84C38.58 25.79 40 27.2 40 28.95C40 30.69 38.58 32.1 36.84 32.1H28.95Z"
        fill={`url(#paint2_linear_${idJitter})`}
      />
      <defs>
        <filter
          id={`filter0_i_${idJitter}`}
          x="25.79"
          y="8.92"
          width="6.32"
          height="15.29"
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
          <feOffset dy="-1.08" />
          <feGaussianBlur stdDeviation="0.54" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.05 0" />
          <feBlend mode="plus-darker" in2="shape" result={`effect1_innerShadow_${idJitter}`} />
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
          x1="28.95"
          y1="10"
          x2="28.95"
          y2="24.21"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#37D492" />
          <stop offset="1" stopColor="#2EB67D" />
        </linearGradient>
        <linearGradient
          id={`paint2_linear_${idJitter}`}
          x1="32.89"
          y1="25.79"
          x2="32.89"
          y2="32.1"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFCC58" />
          <stop offset="1" stopColor="#ECAA2E" />
        </linearGradient>
      </defs>
    </svg>
  );
};

const NotionTile = (props: React.ComponentPropsWithoutRef<"svg">) => {
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
      <g filter={`url(#filter0_d_${idJitter})`}>
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M29.1559 9.76696L12.2566 11.0152C10.8932 11.1331 10.4189 12.0239 10.4189 13.0917V31.6178C10.4189 32.4495 10.7143 33.1611 11.4268 34.1121L15.3993 39.2775C16.0519 40.1092 16.6453 40.2875 17.8914 40.2283L37.5162 39.0402C39.1755 38.922 39.651 38.1493 39.651 36.8434V16.0013C39.651 15.3263 39.3844 15.1318 38.5995 14.5558L33.0703 10.6575C31.7653 9.70862 31.2317 9.5886 29.1559 9.76665V9.76696ZM18.3352 15.6602C16.7327 15.768 16.3693 15.7924 15.4591 15.0524L13.1453 13.212C12.9102 12.9738 13.0284 12.6766 13.6209 12.6174L29.8666 11.4302C31.2308 11.3111 31.9412 11.7866 32.4748 12.202L35.261 14.2208C35.3801 14.2809 35.6764 14.6361 35.32 14.6361L18.5429 15.6461L18.3352 15.6602ZM16.467 36.6654V18.972C16.467 18.1993 16.7043 17.8429 17.4147 17.7831L36.6842 16.6549C37.3378 16.5959 37.6331 17.0113 37.6331 17.7828V35.3582C37.6331 36.1309 37.514 36.7845 36.4472 36.8434L18.0075 37.9123C16.9407 37.9713 16.4673 37.6161 16.4673 36.6654H16.467ZM34.6694 19.9206C34.7876 20.4551 34.6694 20.9896 34.135 21.0506L33.2462 21.2269V34.2902C32.4745 34.7055 31.7641 34.9428 31.1704 34.9428C30.2214 34.9428 29.9844 34.6457 29.2738 33.7557L23.4618 24.6117V33.4585L25.3004 33.8748C25.3004 33.8748 25.3004 34.9438 23.817 34.9438L19.7275 35.1811C19.6084 34.9428 19.7275 34.3494 20.142 34.2312L21.21 33.935V22.2378L19.7279 22.1177C19.6087 21.5833 19.905 20.8115 20.7357 20.7516L25.1235 20.4563L31.1707 29.7185V21.5243L29.6293 21.3472C29.5101 20.6927 29.9844 20.2172 30.5769 20.1592L34.6694 19.9206Z"
          fill="black"
        />
      </g>
      <defs>
        <filter
          id={`filter0_d_${idJitter}`}
          x="6.77877"
          y="7.87718"
          width="36.5123"
          height="37.8214"
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
          <feOffset dy="1.82009" />
          <feGaussianBlur stdDeviation="1.82009" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.1 0" />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result={`effect1_dropShadow_${idJitter}`}
          />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2={`effect1_dropShadow_${idJitter}`}
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
      </defs>
    </svg>
  );
};

const RailwayTile = (props: React.ComponentPropsWithoutRef<"svg">) => {
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
            d="M7.82509 22.5005C7.7425 23.0793 7.68876 23.662 7.66406 24.2462H33.9983C33.9063 24.0665 33.7828 23.9045 33.6582 23.746C29.1562 17.9296 26.7344 18.4339 23.2701 18.2862C22.1151 18.2387 21.3318 18.2196 16.7344 18.2196C14.2737 18.2196 11.5986 18.2259 8.99364 18.2328C8.65642 19.143 8.33119 20.0253 8.17284 20.743H21.6674V22.5005H7.82509ZM34.2059 26.0054H7.67757C7.70533 26.4744 7.74908 26.9371 7.81226 27.3935H32.3043C33.3962 27.3935 34.0073 26.7741 34.2059 26.0054ZM9.18822 32.1881C9.18822 32.1881 13.2485 42.1579 24.9807 42.335C31.993 42.335 38.0182 38.1703 40.7551 32.1881H9.18822Z"
            fill={`url(#paint1_linear_${idJitter})`}
          />
          <path
            d="M24.9805 7.66504C18.4968 7.66504 12.8548 11.2255 9.87528 16.4887C12.2037 16.4838 16.7383 16.481 16.7383 16.481H16.7394V16.4793C22.0993 16.4793 22.2985 16.5032 23.3455 16.5469L23.9939 16.5708C26.2522 16.6461 29.0279 16.8886 31.2119 18.541C32.3974 19.4372 34.1091 21.4154 35.1295 22.8246C36.0728 24.1281 36.3441 25.6265 35.7028 27.0622C35.1125 28.3816 33.8423 29.1686 32.3041 29.1686H8.22914C8.22914 29.1686 8.37246 29.7761 8.58735 30.4467H41.4504C42.034 28.6926 42.3323 26.8561 42.334 25.0074C42.3343 15.4304 34.5648 7.66504 24.9805 7.66504Z"
            fill={`url(#paint2_linear_${idJitter})`}
          />
        </g>
      </g>
      <defs>
        <filter
          id={`filter0_ddddi_${idJitter}`}
          x="1.92877"
          y="6.51798"
          width="46.1405"
          height="56.464"
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
          <feOffset dy="1.14706" />
          <feGaussianBlur stdDeviation="1.14706" />
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
          <feOffset dy="3.44118" />
          <feGaussianBlur stdDeviation="1.72059" />
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
          <feOffset dy="8.02941" />
          <feGaussianBlur stdDeviation="2.29412" />
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
          <feOffset dy="14.9118" />
          <feGaussianBlur stdDeviation="2.86765" />
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
          <feGaussianBlur stdDeviation="0.458823" />
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
          gradientTransform="translate(25.335 51.5) rotate(-90) scale(54.5 44.0328)"
        >
          <stop stopColor="#9C07B5" />
          <stop offset="1" stopColor="#6114B9" />
        </radialGradient>
        <linearGradient
          id={`paint1_linear_${idJitter}`}
          x1="24.999"
          y1="7.66504"
          x2="24.8599"
          y2="41.9994"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="white" stopOpacity="0.5" />
        </linearGradient>
        <linearGradient
          id={`paint2_linear_${idJitter}`}
          x1="24.999"
          y1="7.66504"
          x2="24.8599"
          y2="41.9994"
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

const VercelTile = (props: React.ComponentPropsWithoutRef<"svg">) => {
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
            d="M37.6934 35.7358L25 13.75L12.3066 35.7358H37.6934Z"
            fill={`url(#paint1_linear_${idJitter})`}
          />
        </g>
      </g>
      <defs>
        <filter
          id={`filter0_ddddi_${idJitter}`}
          x="4.03536"
          y="12.0957"
          width="41.9293"
          height="53.4167"
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
          <feOffset dy="1.65426" />
          <feGaussianBlur stdDeviation="1.65426" />
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
          <feOffset dy="4.96277" />
          <feGaussianBlur stdDeviation="2.48138" />
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
          <feOffset dy="11.5798" />
          <feGaussianBlur stdDeviation="3.30851" />
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
          <feOffset dy="21.5053" />
          <feGaussianBlur stdDeviation="4.13564" />
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
          <feGaussianBlur stdDeviation="0.661703" />
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
          x1="25"
          y1="13.75"
          x2="25.9223"
          y2="37.7718"
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

export {
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
};
