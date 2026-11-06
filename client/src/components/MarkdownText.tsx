import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Tailwind resets every element, so the Markdown tags get their look here instead of from a typography plugin.
const components: Components = {
  h1: ({ node: _node, ...props }) => <h1 className="mt-3 mb-1.5 text-base font-semibold first:mt-0" {...props} />,
  h2: ({ node: _node, ...props }) => <h2 className="mt-3 mb-1.5 text-[15px] font-semibold first:mt-0" {...props} />,
  h3: ({ node: _node, ...props }) => <h3 className="mt-2.5 mb-1 font-semibold first:mt-0" {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className="mt-2 mb-1 font-semibold first:mt-0" {...props} />,
  p: ({ node: _node, ...props }) => <p className="my-1.5 first:mt-0 last:mb-0" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-1.5 list-disc pl-5" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-1.5 list-decimal pl-5" {...props} />,
  li: ({ node: _node, ...props }) => <li className="my-0.5" {...props} />,
  a: ({ node: _node, ...props }) => <a className="text-link underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />,
  blockquote: ({ node: _node, ...props }) => <blockquote className="my-1.5 border-l-[3px] border-line-strong pl-2.5 text-muted" {...props} />,
  hr: ({ node: _node, ...props }) => <hr className="my-2 border-line" {...props} />,
  pre: ({ node: _node, ...props }) => <pre className="my-1.5 overflow-x-auto rounded-md border border-line bg-surface-2 p-2.5 font-mono text-xs [&>code]:bg-transparent [&>code]:p-0" {...props} />,
  code: ({ node: _node, ...props }) => <code className="rounded bg-subtle px-1 py-px font-mono text-[0.85em]" {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="border-collapse text-xs" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => <th className="border border-line bg-surface-2 px-2 py-1 text-left font-semibold" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border border-line px-2 py-1 align-top" {...props} />,
};

// Agents write GitHub-flavoured Markdown; the feed shows it formatted. Raw HTML in the text stays text.
export function MarkdownText({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
      {text}
    </Markdown>
  );
}
