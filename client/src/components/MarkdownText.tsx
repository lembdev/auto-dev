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
  a: ({ node: _node, ...props }) => <a className="text-blue-600 underline dark:text-blue-400" target="_blank" rel="noreferrer" {...props} />,
  blockquote: ({ node: _node, ...props }) => <blockquote className="my-1.5 border-l-[3px] border-neutral-300 pl-2.5 text-neutral-600 dark:border-neutral-600 dark:text-neutral-400" {...props} />,
  hr: ({ node: _node, ...props }) => <hr className="my-2 border-neutral-300 dark:border-neutral-700" {...props} />,
  pre: ({ node: _node, ...props }) => <pre className="my-1.5 overflow-x-auto rounded-md bg-neutral-200/70 p-2 font-mono text-xs dark:bg-neutral-800 [&>code]:bg-transparent [&>code]:p-0" {...props} />,
  code: ({ node: _node, ...props }) => <code className="rounded bg-neutral-200/70 px-1 py-px font-mono text-[0.85em] dark:bg-neutral-800" {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="border-collapse text-xs" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => <th className="border border-neutral-300 px-2 py-1 text-left font-semibold dark:border-neutral-700" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border border-neutral-300 px-2 py-1 align-top dark:border-neutral-700" {...props} />,
};

// Agents write GitHub-flavoured Markdown; the feed shows it formatted. Raw HTML in the text stays text.
export function MarkdownText({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
      {text}
    </Markdown>
  );
}
