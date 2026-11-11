-- ============================================================================
-- Schema: Monitoramento e Análise Inteligente de Licitações (PNCP)
-- ============================================================================

CREATE TABLE IF NOT EXISTS licitacoes (
    id SERIAL PRIMARY KEY,
    cnpj_orgao VARCHAR(20) NOT NULL,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    numero_controle_pncp VARCHAR(100),
    orgao_nome VARCHAR(255),
    uf CHAR(2),
    municipio VARCHAR(150),
    modalidade_nome VARCHAR(100),
    objeto_compra TEXT NOT NULL,
    valor_total_estimado NUMERIC(15, 2),
    data_publicacao TIMESTAMP,
    data_abertura_proposta TIMESTAMP,
    data_encerramento_proposta TIMESTAMP,
    link_sistema_origem TEXT,
    url_edital TEXT,
    criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_licitacao_pncp UNIQUE (cnpj_orgao, ano, sequencial)
);

CREATE TABLE IF NOT EXISTS licitacao_analises (
    id SERIAL PRIMARY KEY,
    licitacao_id INTEGER NOT NULL UNIQUE REFERENCES licitacoes(id) ON DELETE CASCADE,
    fonte_analise VARCHAR(30) NOT NULL, -- 'PDF' ou 'OBJETO_FALLBACK'
    modelo_llm VARCHAR(100) NOT NULL,
    categoria VARCHAR(80) NOT NULL DEFAULT 'saude geral',
    status_prospeccao VARCHAR(20) NOT NULL DEFAULT 'APROVADA', -- 'APROVADA' ou 'DESCARTADA'
    pasta_local TEXT,
    data_prospeccao DATE NOT NULL DEFAULT CURRENT_DATE,
    resumo_executivo TEXT NOT NULL,
    itens_principais JSONB NOT NULL DEFAULT '[]'::jsonb,
    exigencias_tecnicas JSONB NOT NULL DEFAULT '[]'::jsonb,
    prazos_criticos JSONB NOT NULL DEFAULT '{}'::jsonb,
    score_oportunidade SMALLINT NOT NULL CHECK (score_oportunidade BETWEEN 1 AND 10),
    justificativa_score TEXT NOT NULL,
    riscos_identificados JSONB NOT NULL DEFAULT '[]'::jsonb,
    criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Migração segura para bancos já existentes
ALTER TABLE licitacao_analises ADD COLUMN IF NOT EXISTS categoria VARCHAR(80) NOT NULL DEFAULT 'saude geral';
ALTER TABLE licitacao_analises ADD COLUMN IF NOT EXISTS status_prospeccao VARCHAR(20) NOT NULL DEFAULT 'APROVADA';
ALTER TABLE licitacao_analises ADD COLUMN IF NOT EXISTS pasta_local TEXT;
ALTER TABLE licitacao_analises ADD COLUMN IF NOT EXISTS data_prospeccao DATE NOT NULL DEFAULT CURRENT_DATE;

-- Tabela específica para licitações que passaram pelo filtro de saúde,
-- foram analisadas pela IA, mas foram DESCARTADAS (Score abaixo do mínimo)
CREATE TABLE IF NOT EXISTS licitacoes_descartadas (
    id SERIAL PRIMARY KEY,
    licitacao_id INTEGER NOT NULL UNIQUE REFERENCES licitacoes(id) ON DELETE CASCADE,
    cnpj_orgao VARCHAR(20) NOT NULL,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    orgao_nome VARCHAR(255),
    municipio VARCHAR(150),
    uf CHAR(2),
    categoria VARCHAR(80) NOT NULL,
    objeto_compra TEXT NOT NULL,
    valor_total_estimado NUMERIC(15, 2),
    score_oportunidade SMALLINT NOT NULL,
    motivo_descarte TEXT NOT NULL,
    riscos_principais JSONB NOT NULL DEFAULT '[]'::jsonb,
    modelo_llm VARCHAR(100) NOT NULL,
    data_prospeccao DATE NOT NULL DEFAULT CURRENT_DATE,
    criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Índices para performance de deduplicação, filtros e relatórios diários
CREATE INDEX IF NOT EXISTS idx_licitacoes_chave_pncp
    ON licitacoes (cnpj_orgao, ano, sequencial);

CREATE INDEX IF NOT EXISTS idx_licitacoes_uf_municipio
    ON licitacoes (uf, municipio);

CREATE INDEX IF NOT EXISTS idx_licitacoes_data_encerramento
    ON licitacoes (data_encerramento_proposta);

CREATE INDEX IF NOT EXISTS idx_licitacao_analises_score
    ON licitacao_analises (score_oportunidade DESC);

CREATE INDEX IF NOT EXISTS idx_licitacao_analises_data_prospeccao
    ON licitacao_analises (data_prospeccao, status_prospeccao);

CREATE INDEX IF NOT EXISTS idx_licitacoes_descartadas_data_prospeccao
    ON licitacoes_descartadas (data_prospeccao);

CREATE INDEX IF NOT EXISTS idx_licitacao_analises_exigencias_gin
    ON licitacao_analises USING GIN (exigencias_tecnicas);
