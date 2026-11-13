import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { domBuilder } from '../../src/shared/dom.js';

function builder() {
  const { document } = new JSDOM('<!doctype html><body></body>').window;
  return { document, el: domBuilder(document) };
}

describe('domBuilder', () => {
  it('treats markup in text as plain text', () => {
    const { el } = builder();
    const node = el('p', null, '<img src=x onerror=alert(1)>');
    expect(node.children).toHaveLength(0);
    expect(node.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('sets attributes with setAttribute, so quotes cannot break out', () => {
    const { el } = builder();
    const node = el('li', { title: '" onmouseover="alert(1)' });
    expect(node.getAttribute('title')).toBe('" onmouseover="alert(1)');
    expect(node.hasAttribute('onmouseover')).toBe(false);
  });

  it('sets true as an empty attribute and leaves false, null and undefined off', () => {
    const { el } = builder();
    const node = el('input', { checked: true, disabled: false, name: null, value: undefined, 'data-x': true });
    expect(node.getAttribute('checked')).toBe('');
    expect(node.getAttribute('data-x')).toBe('');
    expect(node.hasAttribute('disabled')).toBe(false);
    expect(node.hasAttribute('name')).toBe(false);
    expect(node.hasAttribute('value')).toBe(false);
  });

  it('appends nodes, numbers and nested arrays, and skips empty children', () => {
    const { el } = builder();
    const node = el('div', null,
      'a', 1, null, undefined, false,
      [el('span', null, 'b'), ['c']]);
    expect(node.textContent).toBe('a1bc');
    expect(node.querySelector('span').textContent).toBe('b');
  });

  it('creates nodes in the document it was given', () => {
    const { document, el } = builder();
    expect(el('div').ownerDocument).toBe(document);
  });
});
