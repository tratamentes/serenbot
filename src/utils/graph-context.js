/**
 * Utilitário para consultar o Grafo de Conhecimento (graphify-out)
 * Objetivo: Fornecer contexto preciso aos agentes com o mínimo de tokens.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const GRAPH_BASE = process.env.GRAPH_PATH
  || path.join(process.env.HOME || '/root', 'graphify-out');

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cachedGraph = null;
let _cacheTime   = 0;

function loadGraph() {
  if (_cachedGraph && Date.now() - _cacheTime < CACHE_TTL_MS) return _cachedGraph;
  const fullPath = path.join(GRAPH_BASE, 'graph.json');
  try {
    if (!fs.existsSync(fullPath)) {
      logger.warn('Grafo não encontrado em ' + fullPath);
      return null;
    }
    _cachedGraph = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    _cacheTime   = Date.now();
    return _cachedGraph;
  } catch (err) {
    logger.error('Erro ao carregar grafo', err);
    return null;
  }
}

/**
 * Procura um nó por label ou ID e retorna o seu contexto.
 */
function getContext(term, target = 'cliente') {
  const graph = loadGraph();
  if (!graph || !graph.nodes) return "Contexto não disponível.";

  const termLower = term.toLowerCase();
  
  // 1. Tentar encontrar o melhor nó (por label ou ID)
  const node = graph.nodes.find(n => 
    (n.label && n.label.toLowerCase().includes(termLower)) || 
    n.id.toLowerCase().includes(termLower)
  );

  if (!node) return `Não encontrei informação específica sobre "${term}".`;

  // 2. Encontrar relações diretas (vizinhos) para dar contexto
  const relations = graph.links
    .filter(l => l.source === node.id || l.target === node.id)
    .map(l => {
      const isSource = l.source === node.id;
      const targetId = isSource ? l.target : l.source;
      const targetNode = graph.nodes.find(n => n.id === targetId);
      const relationLabel = isSource ? `-> ${l.relation} ->` : `<- ${l.relation} <-`;
      return `${node.label} ${relationLabel} ${targetNode ? targetNode.label : targetId}`;
    });

  return {
    topic: node.label,
    description: `Dados extraídos de ${node.source_file}`,
    connections: relations.slice(0, 10) // Limitar para poupar tokens
  };
}

module.exports = { getContext };
