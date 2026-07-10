const REMOTE_MEDIA_ATTR_RE =
  /<(?:img|source|video|audio|track|image)\b[^>]*\s(?:src|srcset|poster|href|xlink:href)\s*=\s*(?:"[^"]*https?:\/\/|'[^']*https?:\/\/|[^\s>]*https?:\/\/)/i;
const REMOTE_CSS_URL_RE = /url\(\s*(?:"https?:\/\/|'https?:\/\/|https?:\/\/)/i;

export function hasRemoteEmailMedia(html: string): boolean {
  return REMOTE_MEDIA_ATTR_RE.test(html) || REMOTE_CSS_URL_RE.test(html);
}
