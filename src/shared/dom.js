/**
 * Builds DOM nodes without HTML strings, so chat titles, error messages and other
 * dynamic text can never be parsed as markup. Used instead of innerHTML everywhere.
 *
 *   el('p', { class: 'note' }, 'Deleted ', el('strong', null, '3'), ' chats')
 *
 * Attributes: values go through setAttribute. `true` sets an empty (boolean) attribute;
 * `false`, null and undefined leave the attribute off.
 * Children: strings and numbers become text nodes, nodes are appended as they are,
 * arrays are flattened, and null, undefined and false are skipped.
 */

/** @param {Document} doc */
export function domBuilder(doc) {
  function append(parent, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) {
      for (const c of child) append(parent, c);
      return;
    }
    parent.append(typeof child === 'object' ? child : String(child));
  }

  return function el(tag, attrs, ...children) {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs ?? {})) {
      if (value == null || value === false) continue;
      node.setAttribute(name, value === true ? '' : String(value));
    }
    append(node, children);
    return node;
  };
}

/** `domBuilder` bound to the current page's document. */
export function el(tag, attrs, ...children) {
  return domBuilder(document)(tag, attrs, ...children);
}
