# Agenda Diocesana — etapa 1, preparada sem implantação

Este diretório contém uma implementação para homologação isolada. Nenhum arquivo
de `agenda-app` foi alterado. Não há workflow em `.github/workflows`, publicação,
credencial de produção, migração aplicada ou agendamento ativado neste pacote.
Os ambientes do Diretório permanecem fora do escopo.

## Reproduzir os testes locais

Em Linux x64 com Node 22+ e tar, a partir deste diretório:

```sh
npm ci
npm run prepare:local
npm run check
npm test
```

`prepare:local` extrai um Chromium local e copia somente imagens públicas já
existentes em `agenda-app` para a referência de teste Sites 16. Não acessa serviços
externos. Os testes de banco usam PostgreSQL 17.5 em PGlite, com esquema e funções
de vinculação equivalentes aos inventariados, dados sintéticos e papéis separados.
O navegador bloqueia todas as requisições externas e usa respostas sintéticas.
Isso não substitui homologação com Supabase Auth/PostgREST/Edge reais.

## Arquivos e comportamento

| Arquivo | Correção |
|---|---|
| `functions/vsc-agenda-sync/core.mjs` | Administrador ativo validado por Auth e tabela de acesso; serviço com segredo exclusivo; HTTP com limites, Retry-After e backoff; ICS, recorrências, exceções, fusos; execução e erros sanitizados. |
| `functions/vsc-agenda-sync/index.ts`, `deno.json`, `functions/config.toml` | Adaptador Edge, dependências fixadas e autenticação interna obrigatória em ambos os caminhos. |
| `functions/vsc-agenda-admin-dashboard/index.ts` | Encaminha o JWT do administrador ao sincronizador; histórico protegido em `GET ?view=sync_history`; não inventa data de sucesso. Demais ações preservadas. |
| `functions/vsc-agenda/index.ts` | Dados previamente sincronizados continuam disponíveis se a última tentativa falhar; alteração de uma linha no mapeamento de disponibilidade. |
| `sql/01-stabilization.sql` | RPCs com execução somente por service_role, SECURITY INVOKER, search_path restrito, lease com fencing, validação e substituição por fonte em uma transação. Preserva UID, PK existente, vínculos válidos e histórico fora da janela. |
| `sql/02-observability.sql` | Visão exclusiva do servidor com última tentativa, último sucesso, origem, contagem, duração e falhas. |
| `sql/04-rollback-security.sql` | Contenção e privilégios seguros durante reversão, sem reabrir a função de vinculação. |
| `proposals/agenda-sync-DISABLED.yml` | Proposta de GitHub Actions fora do diretório ativo; periodicidade comentada. |
| `baseline/` | Código anterior das três funções relevantes e referência pública do frontend Sites 16 para comparação e regressão. |

## Autorização e segredo

JWT válido sozinho não autoriza sincronização. O sincronizador consulta
`auth.getUser()` e exige `vsc_agenda_access.role='admin'` e
`access_status='active'`. Não usa metadados editáveis pelo usuário.
O painel encaminha o token do usuário, não a service_role.

O serviço automático utiliza `VSC_AGENDA_SYNC_TOKEN`, valor aleatório com pelo
menos 32 bytes de entropia, instalado exclusivamente nos segredos do Edge e no
ambiente protegido do executor. Nunca vai ao frontend, ao banco de auditoria ou
às respostas. Um JWT de service_role não constitui esse caminho automático.
`verify_jwt=false` é necessário para o cabeçalho do serviço; só pode ser aplicado
junto do handler que autentica internamente ambos os caminhos.

As funções SQL não elevam privilégios, não podem ser executadas por PUBLIC,
anon ou authenticated e as novas tabelas têm RLS sem políticas para usuários.
O service_role já autorizado é o único executor legítimo.

## Integridade e limites

Uma execução obtém lease global de 180 segundos. Uma segunda execução recebe
409. Expiração permite recuperação; o identificador da execução impede que um
processo antigo grave após a entrada de outro.

Cada fonte é validada integralmente antes de qualquer escrita. Uma RPC executa
upsert, reconciliação na janela, vinculação e atualização do último sucesso em
uma transação. Falha em qualquer passo reverte a fonte inteira. Fontes são
independentes: uma pode atualizar e outra preservar os dados anteriores; o
resultado global será partial ou failed, sem afirmar sucesso completo.

Snapshot vazio, inválido, duplicado, fonte desativada/alterada, data incorreta
ou redução superior a 50% quando há pelo menos dez eventos aborta a fonte.
Calendários legitimamente esvaziados ou reduções grandes exigem revisão
administrativa em homologação; não existe override no frontend.

O UID original e a chave primária (source_key,event_uid,starts_at) são mantidos.
`occurrence_key` registra a identidade original da ocorrência, inclusive quando
uma exceção muda de horário. Vínculos antigos ambíguos sem essa identidade são
retidos, sem exclusão silenciosa, e contados como `legacy_links_retained`.
O sincronizador não altera o Google Calendar. A janela existente de 400 dias
anteriores e 730 dias futuros foi mantida; registros fora dela são preservados.

Retry-After aceita segundos ou data HTTP e nunca é abreviado. Há até três
tentativas por fonte, backoff de 1 e 2 segundos com jitter, timeout HTTP de
10 segundos e orçamento global de 110 segundos, dividido entre as fontes
restantes para evitar que uma fonte lenta impeça as demais. Se a espera exigida ultrapassar
o orçamento, a fonte fica preservada e é registrada para tentativa futura.
Um calendário muito antigo/denso acima dos limites de expansão é rejeitado
inteiro; não há importação parcial silenciosa.

RRULE diário/semanal/mensal/anual, COUNT/UNTIL, EXDATE/RDATE,
RECURRENCE-ID e RANGE=THISANDFUTURE são tratados pelo ICAL.js. Há correção
específica testada para 29/02 anual, preservação de ⚠️/🚫, VTIMEZONE e zonas IANA.
Sem fuso explícito, usa o fuso do calendário ou America/Sao_Paulo.

## Agendamento proposto — desativado

Uma execução por hora, minuto 17 UTC: `17 * * * *`. Para oito fontes são 192
downloads básicos por dia, sem contar tentativas e acionamentos manuais.
As fontes são processadas em sequência, com 800 ms entre elas. GitHub Actions
pode atrasar ou perder execuções: não é um relógio com garantia de entrega.
O último sucesso por fonte e as falhas do executor precisam ser monitorados.
Em repositórios públicos, agendamentos podem ser desativados após 60 dias sem
atividade; a homologação deve validar também detecção de ausência de execução.

Instalar primeiro em repositório isolado de homologação, na branch padrão
exigida pelo GitHub para disparos agendados, ou em infraestrutura de teste
equivalente. Usar ambiente separado `agenda-homologacao`, segredos próprios, permissões
mínimas e concurrency do executor, além do lease do banco. A proposta não contém
cron ativo. Primeiro executar manualmente em homologação; ativar por tempo
controlado ali e medir atraso, limites e duração antes de pedir aprovação de
produção. Em produção, usar outro ambiente e segredos próprios.

Não adotar pg_net com o segredo estático sem revisar seus privilégios no banco
compartilhado. Não alterar permissões globais desse projeto nesta etapa.
Antes de ativar qualquer executor, confirmar com o responsável que não existe
agendamento externo não visível nos mecanismos examinados.

## Homologação obrigatória antes de produção

1. Criar projeto Supabase separado ou branch realmente isolada; o Site de
   homologação do Diretório não basta. Não copiar credenciais, usuários reais
   ou integrações de e-mail para testes.
2. Aplicar os SQLs 01 e 02 à cópia de esquema com dados sintéticos. Confirmar
   grants, RLS, PostgREST, search_path e chamadas simultâneas em sessões reais.
3. Instalar as três funções preparadas somente nesse projeto. Testar usuários
   Auth reais: comum, administrador ativo, suspenso, anônimo, JWT inválido e
   serviço com segredo exclusivo. Confirmar o comportamento do gateway.
4. Testar calendários sintéticos/controlados, falhas HTTP/gravação, lease
   expirado, mudanças de fonte, recorrências e atualização parcial entre fontes.
5. Rodar o workflow preparado com segredo de homologação; depois validar
   horário real, retorno HTTP e alerta de falhas durante pelo menos 24 horas.
6. Comparar a leitura real dos calendários públicos com as identidades atuais
   sem escrever no banco. Revisar novas ocorrências e vínculos institucionais.
7. Validar login/recuperação, solicitações, painel, filtros, PDF e PWA no ambiente
   isolado. Os testes locais não enviam e-mails nem executam recuperação real.
8. Ensaiar reversão e recuperação de dados no ambiente isolado e guardar provas.

## Implantação futura — somente após nova autorização

Não há necessidade de nova publicação do Site: os arquivos do frontend não
mudaram. Após homologação e autorização específica para banco/funções:

1. Reconfirmar Site, hashes das funções, fontes e inventário de agendamentos.
2. Obter backup/PITR verificável e exportação criptografada das tabelas da Agenda,
   definições, ACLs, vínculos e configurações; ensaiar restauração isolada.
3. Reservar janela curta, impedir novos sync manuais nela e esperar terminar
   qualquer execução anterior. Nenhum agendamento novo deve estar ativo.
4. Aplicar SQL 01 e 02 em transação, sem apagar registros existentes; registrar
   a alteração pelo procedimento oficial de migrations do projeto.
5. Instalar as três funções em conjunto e configurar o segredo automático no
   servidor. Aplicar verify_jwt=false somente com a autenticação interna nova.
6. Executar uma sincronização manual autorizada e comparar, por fonte, chaves,
   vínculos, resultados e último sucesso. Verificar rotas e regressões.
7. Apresentar resultados e solicitar autorização distinta para ativar o cron.
   Não ativar o arquivo proposto ou os segredos de produção antes disso.

## Reversão verificável

Antes de qualquer implantação futura, ensaiar estes passos em homologação:

1. Desativar o executor, bloquear novas execuções e esperar/encerrar o lease.
2. Restaurar a versão anterior do painel e do leitor arquivada em baseline.
3. Instalar `rollback/vsc-agenda-sync/index.ts`, que retorna 503 sem acessar
   banco ou calendários. A consulta da Agenda permanece disponível, e novas
   sincronizações ficam suspensas enquanto se corrige a versão nova. Não
   reinstalar automaticamente o sincronizador v14: ele mantém os riscos
   de autorização e delete/insert anteriores.
4. Manter o linker sem elevação e sem grants a usuários (SQL 04). Não restaurar
   os ACLs vulneráveis. Não remover as tabelas de histórico nem occurrence_key:
   são aditivas e não impedem o leitor antigo.
5. Comparar contagens, fingerprints e vínculos com o backup. Se necessário,
   restaurar primeiro em banco separado e recuperar somente a Agenda por
   transação aprovada; nunca restaurar o projeto compartilhado inteiro sem
   avaliar os outros aplicativos.
6. Reexecutar testes de leitura, permissões e impressão e registrar o resultado.

Não se afirma que há backup/PITR ou homologação real disponíveis: sua existência,
retenção e restauração precisam ser confirmadas antes da implantação.
