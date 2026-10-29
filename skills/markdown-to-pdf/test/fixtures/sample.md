# Smoke Test Report

This fixture exercises the three features the renderer exists for: a table,
a mermaid diagram and a running header.

| Step | Input | Output |
|---|---|---|
| 1 | Markdown | HTML with diagram placeholders |
| 2 | HTML | Rendered page in headless Chromium |
| 3 | Page | PDF |

```mermaid
flowchart LR
  md[Markdown file] --> extract[Extract mermaid fences]
  extract --> html[markdown-it to HTML]
  html --> chrome[Chromium renders SVG]
  chrome --> pdf[PDF]
```

Closing paragraph.
