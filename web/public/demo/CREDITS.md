# Demo asset credits

Both artworks are in the public domain (PD-Art: faithful photographic
reproductions of two-dimensional public-domain works). Local copies are
downscaled from Wikimedia Commons originals:

- `assets/degas-ballet-class.jpg` — Edgar Degas, *The Ballet Class* (c. 1873–76),
  Musée d'Orsay. Source: <https://commons.wikimedia.org/wiki/File:Edgar_Degas_-_The_Ballet_Class_-_Google_Art_Project.jpg>
- `assets/morisot-the-cradle.jpg` — Berthe Morisot, *The Cradle* (1872),
  Musée d'Orsay. Source: <https://commons.wikimedia.org/wiki/File:Berthe_Morisot_-_The_Cradle_-_Google_Art_Project.jpg>

`transcripts/assets/lesson-013/` holds the same two downscaled images again,
under the content-hash filenames the archived transcript refers to. The real
archive keeps full-resolution originals (6 MB and 12 MB) — far too heavy for a
published demo — so `npm run demo:snapshot` skips any asset over its size cap and
preserves these hand-placed downscaled stand-ins instead of overwriting them.

`lesson.json` is a real lesson from the author's own course history, lightly
trimmed, replayed verbatim in demo mode.
