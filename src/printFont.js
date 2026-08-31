// The font used by the printable customer documents (invoice, statement).
//
// WHY THIS EXISTS
// Those documents are built as an HTML string and written into a `window.open`
// popup, then printed. They used to declare `font-family: Arial, Helvetica,
// sans-serif`, which is not a font — it is a request that the device supply
// one. Almost none of the devices these are printed from actually have Arial:
// Android maps it to Roboto, and the field tablets and shop printers each
// substitute something different again. The result was that the same statement
// rendered differently on every device, with column widths and page breaks
// moving accordingly.
//
// So the document now carries its own font. Inter is embedded as base64 in the
// stylesheet, which means the popup needs nothing from the device and nothing
// from the network — it renders identically everywhere, including offline.
//
// WHY BASE64 RATHER THAN A LINKED FILE
// The popup is an `about:blank` document filled by `document.write`, so its
// base URL is not the app's — relative asset URLs do not resolve. An absolute
// URL would resolve, but it would need the network at the moment of printing
// and could easily lose the race against `print()`, silently falling back to a
// device font. A data URI has neither problem.
//
// LICENCE
// Inter is licensed under the SIL Open Font License 1.1, which permits
// embedding in a document like this. Shipped via the `@fontsource/inter`
// package; `?inline` is what makes Vite emit it as a data URI rather than a
// separate hashed asset file.
//
// COST: two weights, latin subset, roughly 64 KB of base64 in the bundle. Only
// the two customer-facing documents use it — the app's own UI and the internal
// printed reports are untouched.
import interRegular from '@fontsource/inter/files/inter-latin-400-normal.woff2?inline';
import interBold from '@fontsource/inter/files/inter-latin-700-normal.woff2?inline';

// Named 'OasisPrint' rather than 'Inter' on purpose: if a device happens to
// have a font called Inter installed, we still want ours, not theirs.
export const PRINT_FONT_FACES = `
          @font-face {
            font-family: 'OasisPrint';
            font-style: normal;
            font-weight: 400;
            font-display: block;
            src: url(${interRegular}) format('woff2');
          }
          @font-face {
            font-family: 'OasisPrint';
            font-style: normal;
            font-weight: 700;
            font-display: block;
            src: url(${interBold}) format('woff2');
          }`;

// The fallbacks after 'OasisPrint' should never be reached. They are there only
// so a document still renders if the embedded face somehow fails to decode.
export const PRINT_FONT_STACK = `'OasisPrint', 'Helvetica Neue', Arial, sans-serif`;
