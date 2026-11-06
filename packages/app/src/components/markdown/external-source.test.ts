import { expect, it } from "vitest";
import { externalMarkdownSource } from "./external-source";

it("retains external message text and links without loading images or interpreting code", () => {
  const source =
    '提示：<font color="blue">原字段🙂</font>\n![chart](https://example.com/image)\n![local](/tmp/private.png)\n![reference][image]\n\n[image]: https://example.com/image2\n\n`![literal](file:///tmp/literal)`';
  expect(externalMarkdownSource(source)).toBe(
    "提示：原字段🙂\n[chart](https://example.com/image)\n[local](/tmp/private.png)\n[reference][image]\n\n[image]: https://example.com/image2\n\n`![literal](file:///tmp/literal)`",
  );
});
