/**
 * Locale registry — must stay in lockstep with `pro/blog/src/i18n/config.ts`
 * in the velxio_blog repo (the static blog at velxio.dev/blog/). Cookie sync
 * uses the `velxio_locale` cookie shared between both surfaces, so the lists
 * MUST agree on locale codes character-for-character.
 *
 * When adding or removing a locale, update both files plus
 * `scripts/translate/locales.mjs` in velxio_blog.
 */

// Product UI languages: Traditional Chinese and English only.
// Keeping this list authoritative also removes unsupported locale routes and
// prevents the language switcher from offering translations we do not maintain.
export const LOCALES = ["zh-tw", "en"] as const;

export type Locale = (typeof LOCALES)[number];

// 「AI物聯網實驗室」brand: Traditional Chinese is the product's home
// language — served prefix-free at `/`; every other locale (including
// English) lives under its own URL prefix.
export const DEFAULT_LOCALE: Locale = "zh-tw";

export const NON_DEFAULT_LOCALES = LOCALES.filter(
  (l): l is Exclude<Locale, typeof DEFAULT_LOCALE> => l !== DEFAULT_LOCALE
);

export type LocaleMeta = {
  /** BCP-47 tag used in `<html lang>` and `hreflang`. */
  htmlLang: string;
  /** Native-language label shown in the language switcher. */
  nativeName: string;
  /** Open Graph locale code (Facebook). */
  ogLocale: string;
  /** Writing direction. */
  dir: "ltr" | "rtl";
};

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  "zh-tw": {
    htmlLang: "zh-TW",
    nativeName: "繁體中文",
    ogLocale: "zh_TW",
    dir: "ltr",
  },
  en: { htmlLang: "en", nativeName: "English", ogLocale: "en_US", dir: "ltr" },
};

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as readonly string[]).includes(value)
  );
}
