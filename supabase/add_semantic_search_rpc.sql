-- Semantic search RPC for prospect embeddings.
-- Requires pgvector extension (CREATE EXTENSION IF NOT EXISTS vector;)
-- and the prospect_embeddings table with an embedding vector(1536) column.

CREATE OR REPLACE FUNCTION match_prospect_embeddings(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.75,
  match_count int DEFAULT 20,
  filter_org_id uuid DEFAULT NULL
)
RETURNS TABLE (
  prospect_id uuid,
  company_name text,
  website text,
  chunk_text text,
  page_source text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id as prospect_id,
    p.company_name,
    p.website,
    pe.chunk_text,
    pe.page_source,
    1 - (pe.embedding <=> query_embedding) as similarity
  FROM prospect_embeddings pe
  JOIN prospects p ON p.id = pe.prospect_id
  WHERE 1 - (pe.embedding <=> query_embedding) > match_threshold
    AND (filter_org_id IS NULL OR p.org_id = filter_org_id)
  ORDER BY pe.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
