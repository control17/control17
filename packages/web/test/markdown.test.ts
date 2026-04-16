import { describe, expect, it } from 'vitest';
import { renderInlineMarkdown } from '../src/lib/markdown.js';

describe('renderInlineMarkdown', () => {
  it('escapes HTML metacharacters', () => {
    expect(renderInlineMarkdown('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('renders bold', () => {
    expect(renderInlineMarkdown('this is **important**')).toBe(
      'this is <strong>important</strong>',
    );
  });

  it('renders italic', () => {
    expect(renderInlineMarkdown('a *subtle* hint')).toBe('a <em>subtle</em> hint');
  });

  it('renders inline code', () => {
    expect(renderInlineMarkdown('use `foo()` instead')).toBe('use <code>foo()</code> instead');
  });

  it('does not format inside code spans', () => {
    expect(renderInlineMarkdown('`**not bold**`')).toBe('<code>**not bold**</code>');
  });

  it('preserves newlines as <br>', () => {
    expect(renderInlineMarkdown('line one\nline two')).toBe('line one<br>line two');
  });

  it('sanitizes then formats — no HTML injection via bold markers', () => {
    expect(renderInlineMarkdown('**<b>x</b>**')).toBe('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
  });
});
