import MarkdownIt from "markdown-it";

const agentMarkdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
});

const defaultLinkOpen = agentMarkdown.renderer.rules.link_open
  ?? ((tokens, index, options, _environment, renderer) => renderer.renderToken(tokens, index, options));

agentMarkdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, index, options, environment, renderer);
};

export function renderAgentMarkdown(value: string): string {
  return agentMarkdown.render(value.trim());
}
