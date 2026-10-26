# Semifrio: quem fala por cima de quem

Independent side project, not connected to RTP. Static website (no server code): open `index.html` through any web
server, e.g. GitHub Pages. Everything is computed in the browser from the CSV files in `data/`.

- `data/epN/overlaps.csv`: one row per overlap (two people speaking at once for at least 0.3 s).
- `data/epN/talk_time.csv`, `topics.csv`, `episode.json`: speaking time, topics, length.
- `clips/`: short audio excerpts so readers can check each overlap.

The numbers come from an automatic analysis and may contain errors. Contact: sideprojectsbc@gmail.com
