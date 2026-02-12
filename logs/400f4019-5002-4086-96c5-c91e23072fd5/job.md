Create a web search job to gather today's news from Uttar Pradesh. The agent will:
1. Open a headless Chrome browser via Playwright
2. Search for "Uttar Pradesh news today" / "UP latest news" on Google
3. Visit top news sites (TOI, The Hindu, Indian Express, NDTV, local UP sources)
4. Extract headlines, summaries, and source links
5. Compile everything into a clean markdown report at `logs/UP_NEWS_REPORT.md`
Focus on: politics, crime, development, sports, weather - all major categories from today/last 24 hours.