'use strict';

// Closed vocabularies for the parser and graph builder.

// Relation key → link label in the tree, allowed subject/object mention types.
const RELATIONS = {
  works_at: { label: 'works at', s: ['person'], o: ['org', 'vc', 'school'] },
  worked_at: { label: 'worked at', s: ['person'], o: ['org', 'vc', 'school'] },
  founded: { label: 'founded', s: ['person', 'org', 'vc'], o: ['org', 'vc', 'product'] },
  invested_in: { label: 'invested in', s: ['vc', 'org', 'person'], o: ['org'] },
  acquired: { label: 'acquired', s: ['org', 'vc'], o: ['org', 'product'] },
  builds: { label: 'builds', s: ['org', 'person'], o: ['product', 'tech'] },
  uses: { label: 'uses', s: ['org', 'product', 'person'], o: ['tech', 'product'] },
  competitor_of: { label: 'competitor of', s: ['org', 'product', 'vc'], o: ['org', 'product', 'vc'] },
  partner_of: { label: 'partner of', s: ['org', 'vc', 'school'], o: ['org', 'vc', 'school'] },
  studied_at: { label: 'studied at', s: ['person'], o: ['school', 'org'] },
  advises: { label: 'advises', s: ['person', 'org', 'vc'], o: ['org', 'vc'] },
  board_member_of: { label: 'board member of', s: ['person'], o: ['org', 'vc', 'school'] },
  subsidiary_of: { label: 'subsidiary of', s: ['org', 'vc', 'product'], o: ['org', 'vc'] },
  customer_of: { label: 'customer of', s: ['org', 'vc'], o: ['org', 'product'] },
  located_in: { label: 'located in', s: ['org', 'vc', 'person', 'school', 'event'], o: ['place'] },
  operates_in: { label: 'operates in', s: ['org', 'vc', 'product'], o: ['sector'] },
  invests_in_sector: { label: 'invests in', s: ['vc'], o: ['sector'] },
  participated_in: { label: 'took part in', s: ['org', 'vc', 'person'], o: ['event'] },
  part_of: { label: 'part of', s: ['concept', 'tech', 'skill', 'sector', 'place'], o: ['concept', 'skill', 'tech', 'sector', 'place'] },
  related_to: { label: 'related to', s: null, o: null },
  requires: { label: 'requires', s: ['skill', 'concept', 'product'], o: ['skill', 'tech', 'concept'] },
  // Added by the graph builder only: an entity named on a page, linked from the page's main entity.
  mentioned_with: { label: 'mentioned with', s: null, o: null },
};

const relationAllowed = (rel, st, ot) => {
  const r = RELATIONS[rel];
  if (!r) return false;
  return (!r.s || r.s.includes(st)) && (!r.o || r.o.includes(ot));
};

// Mention type → tree node type and the area it is filed under.
const TYPE_MAP = {
  person: { type: 'person', area: 'People' },
  org: { type: 'company', area: 'Companies' },
  vc: { type: 'vc', area: 'Investors' },
  product: { type: 'product', area: 'Products & Tech' },
  tech: { type: 'tech', area: 'Products & Tech' },
  concept: { type: 'concept', area: 'Concepts' },
  skill: { type: 'skill', area: 'Skills' },
  place: { type: 'place', area: 'Places' },
  sector: { type: 'field', area: 'Concepts' },
  school: { type: 'school', area: 'Education' },
  event: { type: 'event', area: 'Events' },
};

// Tree node type → mention type (for the gazetteer built from your tree).
const NODE_TO_MENTION = {
  company: 'org', vc: 'vc', person: 'person', hr: 'person', recruiter: 'person', mentor: 'person',
  product: 'product', tech: 'tech', project: 'product', concept: 'concept', field: 'sector', skill: 'skill', credential: 'skill',
  place: 'place', school: 'school', university: 'school', event: 'event',
};

// Technologies worth recognising without an LLM. Case-sensitive entries keep "Go"/"R" from matching prose.
const TECH = [
  'JavaScript', 'TypeScript', 'Python', 'Java', 'Kotlin', 'Swift', 'Rust', 'Golang', 'C++', 'C#', 'Scala', 'Ruby', 'PHP', 'Elixir', 'Haskell', 'Dart',
  'React', 'Next.js', 'Vue', 'Angular', 'Svelte', 'Node.js', 'Express', 'Django', 'Flask', 'FastAPI', 'Spring Boot', 'Rails', 'Laravel', '.NET', 'Flutter', 'React Native',
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Cassandra', 'DynamoDB', 'Elasticsearch', 'OpenSearch', 'ClickHouse', 'Snowflake', 'BigQuery', 'Redshift', 'SQLite', 'CockroachDB', 'Neo4j',
  'Kafka', 'RabbitMQ', 'Spark', 'Flink', 'Airflow', 'dbt', 'Hadoop', 'Databricks',
  'AWS', 'Azure', 'Google Cloud', 'GCP', 'Kubernetes', 'Docker', 'Terraform', 'Ansible', 'Jenkins', 'GitHub Actions', 'Prometheus', 'Grafana', 'Datadog',
  'GraphQL', 'gRPC', 'REST', 'WebSockets',
  'PyTorch', 'TensorFlow', 'JAX', 'scikit-learn', 'XGBoost', 'LightGBM', 'Hugging Face', 'Transformers', 'ONNX', 'MLflow', 'Kubeflow', 'Ray',
  'LangChain', 'LlamaIndex', 'LangGraph', 'CrewAI', 'AutoGen', 'DSPy', 'Semantic Kernel', 'vLLM', 'Ollama',
  'Pinecone', 'Weaviate', 'Qdrant', 'Milvus', 'Chroma', 'pgvector', 'FAISS', 'Vespa', 'LanceDB', 'Redis Vector',
  'OpenAI', 'Anthropic', 'Groq', 'Gemini', 'Llama', 'Mistral', 'GPT-4', 'Claude',
];

const CONCEPTS = [
  'machine learning', 'deep learning', 'reinforcement learning', 'natural language processing', 'computer vision', 'retrieval-augmented generation',
  'RAG', 'vector database', 'vector search', 'embeddings', 'knowledge graph', 'entity resolution', 'record linkage', 'information retrieval',
  'large language models', 'LLM', 'AI agents', 'agentic AI', 'multi-agent systems', 'prompt engineering', 'prompt injection', 'fine-tuning',
  'distributed systems', 'microservices', 'event sourcing', 'system design', 'data engineering', 'MLOps', 'observability', 'fintech', 'payments',
  'web scraping', 'search engines', 'recommendation systems', 'anomaly detection', 'time series', 'semantic search', 'hybrid search',
];

const TITLE = /\b(co-?founder|founder|ceo|cto|coo|cfo|cpo|ciso|chief [a-z]+ officer|president|vice president|vp(?: of)? [a-z]+|svp|evp|head of [a-z &]+|director(?: of [a-z &]+)?|general partner|managing partner|partner|principal|associate|investor|managing director|engineering manager|product manager|staff engineer|principal engineer|senior (?:software )?engineer|software engineer|engineer|developer|data scientist|researcher|designer|recruiter|talent (?:partner|acquisition|lead)|hr (?:manager|lead|business partner)|people (?:partner|lead)|chairman|board member|advisor|content writer|technical writer|writer|editor|journalist|reporter|author|columnist|analyst|consultant|architect|scientist|professor|lecturer|teacher|student|intern|specialist|coordinator|strategist|evangelist|developer advocate)\b/i;

const ORG_SUFFIX = /\b(Inc|Inc\.|Ltd|Ltd\.|LLC|LLP|Corp|Corporation|Pvt|Private Limited|Limited|GmbH|AG|SA|BV|PLC|Technologies|Technology|Labs|Systems|Software|Solutions|Networks|Analytics|Robotics|Health|Payments|Bank|Capital|Ventures|Partners|Fund|Holdings|Group|AI|University|College|Institute|School|Academy|Foundation|Hospital)\b/;
const VC_WORDS = /\b(Capital|Ventures|Venture Partners|Partners|VC|Fund|Investments|Accelerator|Angels?)\b/;

module.exports = { RELATIONS, relationAllowed, TYPE_MAP, NODE_TO_MENTION, TECH, CONCEPTS, TITLE, ORG_SUFFIX, VC_WORDS };
