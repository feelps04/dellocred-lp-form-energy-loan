const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const API_BASE = 'https://api-externo.crefazon.com.br/api/v2';
const API_LOGIN = 'CC030177069';
const API_SENHA = 'Dwqkdo2@';
const PORT = process.env.PORT || 3002;

let _token = null;
let _tokenExp = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const r = await fetch(`${API_BASE}/usuarios/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ usuario: { login: API_LOGIN, senha: API_SENHA, apiKey: '' } })
  });
  const d = await r.json();
  if (!d.success) throw new Error('Login API falhou');
  _token = d.data.autenticacao.token;
  _tokenExp = new Date(d.data.autenticacao.expira).getTime();
  console.log('Token renovado, expira:', d.data.autenticacao.expira);
  return _token;
}

const processes = {};

async function apiReq(endpoint, method = 'GET', body = null) {
  const token = await getToken();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
    signal: ctrl.signal
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(`${API_BASE}${endpoint}`, opts);
    clearTimeout(t);
    if (r.status === 401) { _token = null; return apiReq(endpoint, method, body); }
    return r.json();
  } catch (e) {
    clearTimeout(t);
    return { success: false, errors: [e.message] };
  }
}

const AGENDOR_TOKEN = process.env.AGENDOR_TOKEN || '797207c0-e04d-4e06-9260-f2ba61443645';

function obterCiaEnergiaId(companhia) {
  if (!companhia) return 21202; // Outro
  const cia = companhia.toLowerCase();
  if (cia.includes('enel')) return 21201; // Enel
  if (cia.includes('cpfl')) return 21198; // CPFL
  if (cia.includes('rge')) return 21199; // RGE
  if (cia.includes('neoenergia') || cia.includes('coelba') || cia.includes('celpe') || cia.includes('cosern') || cia.includes('elektro')) return 21200; // Neoenergia
  return 21202; // Outro
}

function formatarDataNascimento(dataIso) {
  if (!dataIso || !dataIso.includes('-')) return dataIso;
  const partes = dataIso.split('-');
  if (partes.length === 3) {
    return `${partes[2]}/${partes[1]}/${partes[0]}`;
  }
  return dataIso;
}

function formatarCPF(cpf) {
  if (!cpf) return cpf;
  const limpo = cpf.replace(/\D/g, '');
  if (limpo.length === 11) {
    return `${limpo.substring(0, 3)}.${limpo.substring(3, 6)}.${limpo.substring(6, 9)}-${limpo.substring(9)}`;
  }
  return cpf;
}

function formatarCEP(cep) {
  if (!cep) return cep;
  const limpo = cep.replace(/\D/g, '');
  if (limpo.length === 8) {
    return `${limpo.substring(0, 5)}-${limpo.substring(5)}`;
  }
  return cep;
}

function obterCategoriaId(proc) {
  if (proc.resultado?.success) {
    return 3989871; // Aprovado
  }
  const erros = proc.resultado?.errors || [];
  const msg = erros.join(' ').toLowerCase();

  if (msg.includes('idade') || msg.includes('faixa etária') || msg.includes('nascimento')) {
    return 4157326; // Idade fora da faixa etária permitida
  }
  if (msg.includes('cia') || msg.includes('concessionaria') || msg.includes('energia') || msg.includes('distribuidora') || msg.includes('elétrica')) {
    return 4156121; // Cia elétrica não atendida
  }
  if (msg.includes('oferta') || msg.includes('limite') || msg.includes('sem oferta')) {
    return 4156142; // Sem ofertas no momento
  }
  if (msg.includes('perfil')) {
    return 4156097; // Perfil não compatível
  }
  if (msg.includes('reprovado')) {
    return 4156096; // Reprovado
  }

  return 4159609; // Padrão: Negado na pré-análise
}

async function enviarParaAgendor(proc) {
  try {
    const uf = proc.endereco?.state || '';
    const cidade = proc.endereco?.city || '';
    const bairro = proc.endereco?.neighborhood || '';
    const rua = proc.endereco?.street || '';

    const emailTemp = `${proc.cpf}@dellocred.online`;
    const personPayload = {
      name: proc.nome,
      cpf: formatarCPF(proc.cpf),
      birthday: proc.nascimento || undefined,
      description: `Cliente originado da Simulação de Crédito da Crefazon no site Dellocred.`,
      ownerUser: 980684,
      category: obterCategoriaId(proc),
      contact: {
        email: emailTemp,
        whatsapp: proc.telefone.startsWith('+') ? proc.telefone : `+55${proc.telefone}`
      },
      address: {
        postalCode: formatarCEP(proc.cep),
        postal_code: formatarCEP(proc.cep),
        cep: proc.cep ? proc.cep.replace(/\D/g, '') : undefined,
        streetName: rua || undefined,
        district: bairro || undefined,
        city: cidade || undefined,
        state: uf || undefined,
        country: 'Brasil'
      },
      customFields: {
        cia_de_energia: obterCiaEnergiaId(proc.companhia),
        data_de_nascimento: formatarDataNascimento(proc.nascimento),
        interesse: "Energia",
        "pre-aprovado_energia": proc.resultado?.success ? "Aprovado" : "Reprovado",
        umblertalk_id: proc.telefone ? proc.telefone.replace(/\D/g, '') : ''
      }
    };

    console.log('[Agendor] Enviando Upsert de Pessoa (Tentativa 1):', proc.nome);
    let personResp = await fetch('https://api.agendor.com.br/v3/people/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Token ${AGENDOR_TOKEN}`
      },
      body: JSON.stringify(personPayload)
    });

    let personData = await personResp.json();

    const rawError = JSON.stringify(personData);
    if (!personData.data?.id && (rawError.includes('somente leitura') || rawError.includes('não pode ser alterado') || rawError.includes('read_only'))) {
      console.warn('[Agendor] Detectado campo customizado somente leitura. Ativando fallback automático...');
      
      delete personPayload.customFields["pre-aprovado_energia"];
      delete personPayload.customFields.umblertalk_id;
      
      const statusPre = proc.resultado?.success ? "Aprovado" : "Reprovado";
      const umblerId = proc.telefone ? proc.telefone.replace(/\D/g, '') : '';
      personPayload.description += `\n\n[Fallback Integração - Campos Bloqueados no Agendor]:\n- Pré-Aprovado Energia: ${statusPre}\n- UmblerTalk ID: ${umblerId}`;
      
      console.log('[Agendor] Enviando Upsert de Pessoa (Tentativa 2 - Fallback):', proc.nome);
      personResp = await fetch('https://api.agendor.com.br/v3/people/upsert', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Token ${AGENDOR_TOKEN}`
        },
        body: JSON.stringify(personPayload)
      });
      personData = await personResp.json();
    }

    if (!personData.data?.id) {
      console.error('[Agendor] Falha no Upsert de Pessoa:', personData);
      return;
    }

    const personId = personData.data.id;
    console.log('[Agendor] Pessoa criada/atualizada com ID:', personId);



  } catch (error) {
    console.error('[Agendor] Erro de Integração:', error.message);
  }
}

async function buscarCidadeId(cep) {
  const cepResp = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`);
  const cepData = await cepResp.json();
  if (!cepData.city) throw new Error('CEP não encontrado');
  const cidResp = await apiReq('/enderecos/cidades', 'POST', { endereco: { nomeCidade: cepData.city, uf: cepData.state } });
  if (!cidResp.success || !cidResp.data?.endereco?.length) throw new Error('Cidade não encontrada na API');
  return { cidadeId: cidResp.data.endereco[0].cidadeId, cepData };
}

app.post('/api/simular', async (req, res) => {
  try {
    const { nome, cpf, nascimento, telefone, companhia, cep } = req.body;

    const { cidadeId, cepData } = await buscarCidadeId(cep);
    console.log('CEP:', cep, '→ cidadeId:', cidadeId);

    const pre = await apiReq('/propostas/pre-analise', 'POST', {
      cliente: { cpf, nome, nascimento },
      profissional: { ocupacaoId: 1 },
      contato: { telefone },
      endereco: { cidadeId },
      operacao: { urlNotificacao: 'https://httpbin.org/post' }
    });

    if (!pre.success) return res.json(pre);
    const processoId = pre.data.processo?.id;
    const propostaId = pre.data.proposta?.id;
    if (!processoId || !propostaId) return res.json({ success: false, errors: ['Proposta não criada'] });

    processes[processoId] = { 
      propostaId, 
      nome, 
      cpf, 
      nascimento, 
      telefone, 
      companhia, 
      cep, 
      endereco: cepData, 
      status: 'EmAndamento', 
      resultado: null, 
      createdAt: Date.now() 
    };

    res.json({ success: true, data: { processoId, propostaId } });
  } catch (e) {
    res.json({ success: false, errors: [e.message] });
  }
});

app.get('/api/status/:processoId', async (req, res) => {
  const proc = processes[req.params.processoId];
  if (!proc) return res.json({ success: false, errors: ['Processo não encontrado'] });
  if (proc.resultado) return res.json({ success: true, data: { status: 'Concluido', resultado: proc.resultado } });

  const st = await apiReq(`/propostas/processamento/${req.params.processoId}`);
  if (st.success && st.data?.evento?.status && st.data.evento.status !== 'EmAndamento') {
    if (st.data.evento.status === 'sucesso' || st.data.evento.status === 'Sucesso') {
      await montarResultado(proc);
    } else {
      proc.resultado = { success: false, errors: [st.data.evento.mensagens?.join(' ') || 'Proposta não aprovada'] };
    }
    if (!proc.crmEnviado) {
      proc.crmEnviado = true;
      enviarParaAgendor(proc).catch(err => console.error('[Agendor] Erro assíncrono:', err));
    }
  }

  if (proc.resultado) return res.json({ success: true, data: { status: 'Concluido', resultado: proc.resultado } });
  res.json({ success: true, data: { status: proc.status } });
});

async function montarResultado(proc) {
  try {
    const { propostaId } = proc;
    const produtos = await apiReq(`/propostas/${propostaId}/produtos-ofertados`);
    if (!produtos.success || !produtos.data?.produtos) {
      proc.resultado = { success: false, errors: produtos.errors || ['Produtos não disponíveis'] };
      return;
    }

    const negados = produtos.data.produtosNegados || [];
    const energiaNegada = negados.find(p => p.id === 6);
    if (energiaNegada) {
      proc.resultado = { success: false, errors: [`Energia não aprovada: ${energiaNegada.motivoNegativa?.join(', ') || 'Consulta negada'}`] };
      return;
    }

    const energia = produtos.data.produtos.find(p => p.id === 6);
    if (!energia) {
      proc.resultado = { success: false, errors: ['Produto Energia não encontrado na oferta'] };
      return;
    }

    const convenio = energia.convenio?.[0];
    const tabela = convenio?.tabelaJuros?.[0];
    const renda = produtos.data.proposta?.valorRendaPresumida || 1500;

    if (!convenio || !tabela) {
      proc.resultado = { success: false, errors: ['Convenio ou tabela de juros não disponível'] };
      return;
    }

    const venc = await apiReq(`/propostas/${propostaId}/calculo-vencimento`, 'POST', {
      produto: { id: 6, convenio: { id: convenio.id }, tabelaJuros: { id: tabela.id } },
      operacao: { vencimento: null, diaRecebimentoId: -5 }
    });
    const dataVenc = venc.data?.vencimento?.[0]?.data;
    if (!dataVenc) {
      proc.resultado = { success: false, errors: ['Erro ao calcular vencimento'] };
      return;
    }

    const lim = await apiReq(`/propostas/${propostaId}/limite-credito`, 'POST', {
      produto: { id: 6, convenio: { id: convenio.id }, tabelaJuros: { id: tabela.id } },
      operacao: { diaRecebimentoId: -5, valorRenda: renda, recalculo: null, vencimento: dataVenc }
    });
    const maximo = lim.data?.valorLimite?.valorMaximoSolicitado || 0;
    if (maximo <= 0) {
      proc.resultado = { success: false, errors: ['Limite de crédito não disponível'] };
      return;
    }

    const sim = await apiReq(`/propostas/${propostaId}/simulacao-credito`, 'POST', {
      produto: { id: 6, convenio: { id: convenio.id }, tabelaJuros: { id: tabela.id } },
      operacao: { vencimento: dataVenc, diaRecebimentoId: -5, valor: maximo, valorRenda: renda, tipoCalculo: 0 }
    });

    proc.resultado = {
      success: true,
      data: {
        propostaId,
        produto: 'Energia',
        convenio: convenio.nome,
        tabelaJuros: tabela.nome,
        valorRendaPresumida: renda,
        valorMaximo: maximo,
        dataVencimento: dataVenc,
        simulacoes: sim.data?.proposta?.prazoValor || []
      }
    };
  } catch (e) {
    proc.resultado = { success: false, errors: [e.message] };
  }
}

app.get('/api/cidades', async (req, res) => {
  const { nome, uf } = req.query;
  const r = await apiReq('/enderecos/cidades', 'POST', { endereco: { nomeCidade: nome, uf } });
  res.json(r);
});

app.get('/api/cep/:cep', async (req, res) => {
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${req.params.cep}`);
    const d = await r.json();
    if (d.errors || !d.street) return res.json({ success: false, errors: ['CEP não encontrado'] });
    res.json({ success: true, data: { uf: d.state, cidade: d.city, bairro: d.neighborhood, rua: d.street } });
  } catch (e) {
    res.json({ success: false, errors: [e.message] });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
