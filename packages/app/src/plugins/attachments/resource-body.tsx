import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ExternalLink } from "lucide-react-native";
import type { PluginAttachmentItem } from "@getpaseo/plugin";
import { Button } from "@/components/ui/button";
import { ExternalMarkdownRenderer } from "@/components/markdown/renderer";
import { openExternalUrl } from "@/utils/open-external-url";

type Block = NonNullable<PluginAttachmentItem["previewBlocks"]>[number];

export function ResourceBody({
  item,
  testID,
  highlight,
  literal,
}: {
  item: Pick<PluginAttachmentItem, "text" | "previewText" | "previewBlocks">;
  testID: string;
  highlight?: string;
  literal?: boolean;
}) {
  const blocks = useMemo(() => {
    const occurrences = new Map<string, number>();
    return (item.previewBlocks ?? []).map((block) => {
      const content = JSON.stringify(block);
      const occurrence = occurrences.get(content) ?? 0;
      occurrences.set(content, occurrence + 1);
      return { block, key: `${content}:${occurrence}` };
    });
  }, [item.previewBlocks]);
  if (!item.previewBlocks?.length) {
    return (
      <Text selectable style={styles.text} testID={testID}>
        <HighlightedText text={item.previewText ?? item.text} query={highlight} literal={literal} />
      </Text>
    );
  }
  return (
    <View style={styles.blocks} testID={testID}>
      {blocks.map(({ block, key }) => (
        <ResourceBlock key={key} block={block} highlight={highlight} literal={literal} />
      ))}
    </View>
  );
}

function HighlightedText({
  text,
  query,
  literal,
}: {
  text: string;
  query?: string;
  literal?: boolean;
}) {
  const parts = useMemo(() => {
    const terms = (literal ? [query?.trim() ?? ""] : (query?.trim().split(/\s+/) ?? [])).filter(
      Boolean,
    );
    if (!terms.length) return [text];
    const expression = new RegExp(
      terms
        .sort((a, b) => b.length - a.length)
        .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|"),
      "giu",
    );
    const result = [];
    let offset = 0;
    for (const match of text.matchAll(expression)) {
      result.push(text.slice(offset, match.index));
      result.push(
        <Text key={match.index} style={styles.highlight} testID="plugin-attachment-highlight">
          {match[0]}
        </Text>,
      );
      offset = match.index + match[0].length;
    }
    result.push(text.slice(offset));
    return result;
  }, [text, query, literal]);
  return parts;
}

function ResourceBlock({
  block,
  highlight,
  literal,
}: {
  block: Block;
  highlight?: string;
  literal?: boolean;
}) {
  const url = block.type === "action" ? block.url : undefined;
  const open = useCallback(() => {
    if (url) void openExternalUrl(url);
  }, [url]);
  if (block.type === "markdown") return <ExternalMarkdownRenderer text={block.text} />;
  if (block.type === "text")
    return (
      <Text selectable style={styles.text}>
        <HighlightedText text={block.text} query={highlight} literal={literal} />
      </Text>
    );
  return (
    <Button
      variant="outline"
      style={styles.action}
      onPress={open}
      disabled={!url}
      leftIcon={url ? ExternalLink : undefined}
    >
      {block.label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  highlight: {
    backgroundColor: theme.colors.statusWarningTint,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  blocks: { gap: theme.spacing[3] },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.6,
  },
  action: { alignSelf: "flex-start" },
}));
