# Lead Scraper Worker

GitHub Actions worker voor de Grantly `lead_scraper` module.

Deze eerste versie is bewust klein:

- bestaande `src/server.mjs` worker kan blijven bestaan
- workflow wordt gestart via `workflow_dispatch`
- worker haalt een publieke lijst-URL op
- worker blokkeert localhost/private IP targets
- worker extraheert eenvoudige lead-signalen uit HTML
- worker post status en kandidaat-leads terug naar Grantly
- er is geen AI-integratie

## Benodigde Grantly-config

Zet in `modules/lead_scraper/config/lead_scraper.php`:

```php
$config['lead_scraper_github_repo_owner']    = 'grntly';
$config['lead_scraper_github_repo_name']     = 'Lead_Scraper_Worker';
$config['lead_scraper_github_workflow_file'] = 'lead-scraper.yml';
$config['lead_scraper_github_workflow_ref']  = 'main';
$config['lead_scraper_github_pat']           = 'VUL_HIER_JE_GITHUB_PAT_IN';
```

De PAT heeft voor deze worker repo minimaal nodig:

- Actions: Read and write
- Contents: Read-only
