-- Níveis das fontes revistos em 22/10 (SOURCE_TIERS, packages/db/src/tiers.ts) depois do
-- ensaio de 18/10. A L3 lê o nível gravado em kb_documents.tier na carga, então documentos
-- que já estão na base precisam acompanhar a lista (L1 e L4 calculam o nível na hora).
-- Só rebaixa, nunca promove; idempotente. Só dados: o schema não muda.
--
-- Conteúdo patrocinado do Estadão (estúdio de conteúdo de marca): publicidade, nível 4.
update kb_documents set tier = 4
where url ~* '^https?://bluestudio\.estadao\.com\.br(/|$)' and tier < 4;

-- PDFs de terceiros hospedados pelo Poder360 (programa de governo, Mensagem ao Congresso):
-- não herdam o nível 2 do jornal, nível 3.
update kb_documents set tier = 3
where url ~* '^https?://static\.poder360\.com\.br(/|$)' and tier < 3;
