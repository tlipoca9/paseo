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
}: {
  item: Pick<PluginAttachmentItem, "text" | "previewText" | "previewBlocks">;
  testID: string;
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
        {item.previewText ?? item.text}
      </Text>
    );
  }
  return (
    <View style={styles.blocks} testID={testID}>
      {blocks.map(({ block, key }) => (
        <ResourceBlock key={key} block={block} />
      ))}
    </View>
  );
}

function ResourceBlock({ block }: { block: Block }) {
  const url = block.type === "action" ? block.url : undefined;
  const open = useCallback(() => {
    if (url) void openExternalUrl(url);
  }, [url]);
  if (block.type === "markdown") return <ExternalMarkdownRenderer text={block.text} />;
  if (block.type === "text")
    return (
      <Text selectable style={styles.text}>
        {block.text}
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
  blocks: { gap: theme.spacing[3] },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.6,
  },
  action: { alignSelf: "flex-start" },
}));
