import type { PluginTheme } from "@getpaseo/plugin";
import type { Theme } from "@/styles/theme";

const pluginThemeCache = new WeakMap<Theme, PluginTheme>();

export function toPluginTheme(theme: Theme): PluginTheme {
  const cached = pluginThemeCache.get(theme);
  if (cached) return cached;
  const converted: PluginTheme = {
    colors: {
      surface0: theme.colors.surface0,
      surface1: theme.colors.surface1,
      surface2: theme.colors.surface2,
      border: theme.colors.border,
      foreground: theme.colors.foreground,
      foregroundMuted: theme.colors.foregroundMuted,
      accent: theme.colors.accent,
      accentForeground: theme.colors.accentForeground,
      statusSuccess: theme.colors.statusSuccess,
      statusWarning: theme.colors.statusWarning,
      statusDanger: theme.colors.statusDanger,
    },
  };
  pluginThemeCache.set(theme, converted);
  return converted;
}
