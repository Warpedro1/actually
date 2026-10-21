// GERADO por scripts/gen-sources.ts a partir de sources/*.yaml — não edite à mão.
// Rode `pnpm --filter @actually/kb-ingest gen:sources` depois de mudar os YAML.

export const APIFY_MANIFEST_RAW: unknown = {
  "crawl": {
    "actor": "apify/website-content-crawler",
    "input": {
      "startUrls": "$START_URLS",
      "maxCrawlPages": "$MAX_PAGES"
    },
    "jobs": [
      {
        "name": "lupa",
        "kind": "factcheck",
        "start_urls": [
          "https://lupa.uol.com.br/"
        ],
        "max_pages": 150
      },
      {
        "name": "aos-fatos",
        "kind": "factcheck",
        "start_urls": [
          "https://aosfatos.org/"
        ],
        "max_pages": 150
      },
      {
        "name": "estadao-verifica",
        "kind": "factcheck",
        "start_urls": [
          "https://estadao.com.br/estadao-verifica/"
        ],
        "max_pages": 150
      },
      {
        "name": "fato-ou-fake",
        "kind": "factcheck",
        "start_urls": [
          "https://g1.globo.com/fato-ou-fake/"
        ],
        "max_pages": 150
      },
      {
        "name": "comprova",
        "kind": "factcheck",
        "start_urls": [
          "https://projetocomprova.com.br/"
        ],
        "max_pages": 150
      },
      {
        "name": "uol-confere",
        "kind": "factcheck",
        "start_urls": [
          "https://noticias.uol.com.br/confere/"
        ],
        "max_pages": 150
      },
      {
        "name": "afp-checamos",
        "kind": "factcheck",
        "start_urls": [
          "https://checamos.afp.com/"
        ],
        "max_pages": 150
      }
    ]
  },
  "youtube": {
    "actor": "curious_coder/youtube-transcript-scraper",
    "videos": []
  },
  "search": {
    "actor": "apify/google-search-scraper",
    "input": {
      "queries": "$QUERIES_NEWLINE"
    }
  }
};

export const FEEDS_RAW: unknown = {
  "feeds": []
};

/** sources/manual/<arquivo>.yaml por nome do arquivo (séries manuais da L2; ver src/indicators/manual.ts). */
export const MANUAL_SERIES_RAW: Record<string, unknown> = {
  "carga_tributaria": {
    "series": "carga_tributaria_pib",
    "unit": "% do PIB",
    "values": [
      {
        "period": "2025",
        "value": 32.4,
        "url": "https://www.tesourotransparente.gov.br/publicacoes/carga-tributaria-do-governo-geral/2025/114",
        "released_at": "2026-04-10",
        "source": "Tesouro Nacional, boletim \"Estimativa da Carga Tributária Bruta do Governo Geral\" de 2025 (divulgado em 10/04/2026)",
        "verified_by": "Texto oficial do Tesouro (gov.br/tesouronacional, notícia \"Carga tributária bruta do Governo Geral atinge 32,40% do PIB em 2025\"): \"Em 2025, a carga tributária bruta (CTB) do governo geral (governo central, governos estaduais e municipais) foi de 32,40% do PIB, o que representa um aumento de 0,18 p.p. do PIB em relação a 2024\". Lido pela ferramenta de busca em 21/10/2026 (o domínio não abre deste ambiente); mesmo número na notícia do Ministério da Fazenda e no título da publicação no Tesouro Transparente."
      },
      {
        "period": "2024",
        "value": 32.22,
        "url": "https://www.tesourotransparente.gov.br/publicacoes/carga-tributaria-do-governo-geral/2025/114",
        "released_at": "2026-04-10",
        "source": "Tesouro Nacional, boletim de 2025 (divulgado em 10/04/2026) — valor de 2024 revisto",
        "verified_by": "Mesma edição e mesmo texto oficial: 32,40% em 2025 com \"aumento de 0,18 p.p. do PIB em relação a 2024\" ⇒ 32,22%; a cobertura da divulgação (Estadão Conteúdo, Istoé Dinheiro) diz \"de 32,22% para 32,40%\". A edição anterior (03/2025) dava 32,32% para 2024: o Tesouro revisou, vale o da edição atual."
      }
    ]
  }
};
