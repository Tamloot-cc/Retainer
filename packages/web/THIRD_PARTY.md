# Third-party source notices

`src/ui/index.tsx`: Button's class-variance-authority and Slot composition is
adapted from [shadcn/ui](https://github.com/shadcn-ui/ui), MIT.
`src/ui/trace.tsx` (Trace) and `src/ui/message.tsx` (Message, Bubble and the
Message Scroller wrapper) are adapted from shadcn/ui's Radix components and
its Nova style, MIT. `src/style.css`: the `shimmer` utility and the
collapsible keyframes are adapted from shadcn/ui's `tailwind.css`, MIT. The chat's layout follows shadcn/ui's AI
Elements patterns (Chat, Message, Reasoning, Tool, Chain of Thought, Sources,
Suggestion, Prompt Input).
`src/routes/dashboards/chart-container.tsx` adapts shadcn/ui's ChartContainer (MIT).
Other UI components are original wrappers around installed Radix primitives and cmdk.
No Twenty or Comp AI source files were copied or translated.

## shadcn/ui — MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Inter — SIL Open Font License 1.1

`public/fonts/inter-latin-{400,500,600}.woff2` are Inter font assets, reused
from the local Twenty website's font distribution. Inter is an independent font
project by Rasmus Andersson. The full license is in `public/fonts/OFL.txt`.
No Twenty component implementation was copied.

## Extension logos

The extension logos identify their respective products and are trademarks of
their owners.

- Exa square icon from the [Exa brand assets](https://exa.ai/brand).
- Gmail icon from the [Google Brand Resource Center](https://about.google/brand-resource-center/products-and-services/).
- Granola favicon from the [Granola website](https://www.granola.ai/favicon/favicon.svg).
- Tamloot favicon from the Tamloot landing page source.

## Nango Frontend SDK — Elastic License 2.0

The Gmail authorization UI uses `@nangohq/frontend`. The license is included
with the built web assets as `licenses/nango-frontend.txt`.
