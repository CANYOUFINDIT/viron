import MarkdownIt from "markdown-it";

const knowledgeMarkdown = new MarkdownIt({
  breaks: false,
  html: false,
  linkify: true,
  typographer: false,
});

const defaultLinkOpen = knowledgeMarkdown.renderer.rules.link_open
  ?? ((tokens, index, options, _environment, renderer) => renderer.renderToken(tokens, index, options));

knowledgeMarkdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, index, options, environment, renderer);
};

function replaceTaskMarkers(value: string): string {
  return value
    .replace(/^(\s*[-+*]\s+)\[ \]\s+/gm, "$1☐ ")
    .replace(/^(\s*[-+*]\s+)\[[xX]\]\s+/gm, "$1☑ ");
}

export function renderKnowledgeMarkdown(value: string, assetDataUrls: Record<string, string> = {}): string {
  const hydrated = value.replace(/knowledge-asset:\/\/([0-9a-f-]{36})/gi, (match, id: string) => assetDataUrls[id] ?? match);
  return knowledgeMarkdown.render(replaceTaskMarkers(hydrated));
}
