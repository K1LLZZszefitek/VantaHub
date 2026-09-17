VANTA HUB V47 — MEDIA THUMBNAIL FIX

PODMIEŃ W REPO TYLKO:
1. index.html
2. server.js

Nie zmieniaj .env, DATABASE_URL ani package.json.

Co poprawiono:
- TikTok: obsługa linków vm.tiktok.com / vt.tiktok.com przez rozwiązanie przekierowania.
- TikTok: próba oficjalnego oEmbed + awaryjnie og:image strony.
- YouTube: automatyczna miniaturka maxresdefault.
- Gdy obraz zewnętrzny faktycznie nie działa, karta pokazuje czytelne BRAK MINIATURKI zamiast pustego pola.
- Pole MINIATURKA (opcjonalnie) w panelu admina nadal działa i ma pierwszeństwo.

Po wdrożeniu:
- Stare wpisy bez thumbnail nie naprawią się same. Usuń stary wpis i dodaj go ponownie,
  albo w panelu dodaj go ponownie z ręcznym URL miniaturki.
