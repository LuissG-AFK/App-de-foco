# Foco

App pessoal de concentração no estilo Forest, feito para usar no celular. Interface em português (pt-BR). Os dados ficam só no aparelho (localStorage).

## Como usar

**Arquivo único (mais simples no celular):** copie `foco.html` para o telefone e abra no navegador (Chrome ou Safari), direto da pasta ou dos arquivos. Não precisa de internet nem de servidor. O progresso é salvo no navegador.

**PWA instalável (tela inicial, offline completo):** coloque a pasta `foco-app` em um servidor HTTPS (ou abra em `localhost`) e use “Adicionar à tela inicial”. A instalação PWA **não funciona** em `file://`.

## O que tem

- **Foco:** gire o círculo para escolher o tempo (5–180 min), diga o que está estudando, toque em **Plantar**. A árvore cresce durante a sessão. **Desistir** murcha a árvore.
- **Pausar / Continuar:** você pode pausar o timer (por exemplo, para ir ao banheiro). O tempo pausado não conta como estudo, a árvore para de crescer e o cronômetro congela. Se uma mesma pausa passar de **1 hora**, a árvore murcha e a sessão não rende pontos — mesmo se o app estiver fechado ou o celular bloqueado (o horário da pausa fica salvo e é conferido ao reabrir).
- **Modo rigoroso** (padrão): sair do app por mais de ~10 segundos *com o timer rodando* murcha a árvore. Pausar é permitido; sair enquanto está pausado não murcha.
- **Modo flexível:** pode sair do app com o timer rodando sem murchar. A pausa também existe, com o mesmo limite de 1 hora.
- **Floresta:** nível, XP, moedas, ofensiva, grade de árvores (incluindo as murchas), histórico e minutos por assunto.
- **Notas:** uma anotação por dia, editável, com calendário e as sessões daquele dia.
- **Prêmios:** você mesmo cadastra recompensas e os critérios (nível, minutos, sessões, ofensiva, assunto, sessão longa, gastar moedas). Vários critérios juntos (E). **Resgatar**, repetível, editar e excluir.
- **Lembretes** de estudo (dias + horário + mensagem) e lembrete opcional da anotação do dia. Exportar **.ics** para o calendário/alarme do celular.
- Backup JSON (exportar/importar), inclusive anotações.

## Limites importantes

- **Detecção de saída:** usa a Page Visibility API e um “heartbeat”. No iOS, o Safari às vezes atrasa ou não dispara esses eventos com o app em segundo plano da forma esperada; o modo rigoroso pode falhar em alguns casos. Manter a tela ligada ajuda (o app pede *wake lock* quando o navegador permite).
- **Notificações de lembrete:** funcionam bem **com o app aberto**. Ao reabrir, o app mostra lembretes atrasados das últimas 3 horas. Com o PWA **fechado** ou removido da memória, o Chrome no Android **não agenda alarmes estáveis** sem um servidor de push. O *Notification Triggers* / *Periodic Background Sync* só existem em alguns navegadores e são instáveis. No iOS, notificação web exige PWA instalado e também **não dispara com o app fechado**.
- **Alarme confiável:** use o botão “Calendário/alarme” e importe o `.ics` no app de Calendário do celular.
- **Som e vibração** dependem do navegador e das permissões do sistema. No iOS o som muitas vezes só toca depois de um toque na página.
- **Instalação PWA** exige HTTPS (ou localhost). O `foco.html` avulso não instala como PWA, mas funciona offline no sentido de não precisar de rede depois de aberto.

## XP e moedas

- 10 XP e 1 moeda por minuto de sessão **concluída**.
- Bônus de sessão longa: +15% (45 min), +30% (60 min), +50% (90 min).
- Bônus de ofensiva: +5% por dia consecutivo, até +50%.
- Sessões murchas não rendem pontos.
