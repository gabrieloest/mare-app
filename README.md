# 🌊 Maré

**Maré** é um aplicativo web *mobile-first* e *privacy-first* (PWA) para monitoramento do ciclo menstrual, libido e bem-estar íntimo. Assim como as marés, nosso corpo e desejo passam por fluxos naturais — o objetivo do app é ajudar pessoas que menstruam a entenderem seus próprios padrões hormonais, físicos e emocionais com total autonomia.

🌐 **Acesse o app:** [https://gabrieloest.github.io/mare-app/](https://gabrieloest.github.io/mare-app/)  
📦 **Repositório:** [https://github.com/gabrieloest/mare-app](https://github.com/gabrieloest/mare-app)

---

## ✨ Principais Funcionalidades

- **Rastreamento de Ciclo e Previsões Inteligentes:** Calendário interativo para registro de menstruação, intensidade do fluxo, escapes (*spotting*) e cálculo adaptativo das fases (Menstrual, Folicular, Ovulatória e Lútea), janela fértil e próxima previsão.
- **Diário de Libido e Saúde Sexual:** Check-in diário rápido (em menos de 15 segundos) na escala de 1 a 5, com marcadores para atividade sexual (com ou sem proteção), masturbação, satisfação, lubrificação, desconforto e fatores externos (sono, estresse, álcool, medicações e exercício).
- **Sintomas, Humor e Contraceptivos:** Tags para sintomas físicos e emocionais, além de módulo contraceptivo (pílula, DIU hormonal ou de cobre, anel, adesivo, implante) com lembretes e adaptação da leitura hormonal (como diferenciar sangramento de privação e supressão ovulatória).
- **Insights, Correlações e Relatório em PDF:** Gráfico nativo cruzando fases do ciclo e libido, leituras educativas contextualizadas e exportação limpa via impressão/PDF para consultas ginecológicas ou terapêuticas.
- **Privacidade, Segurança e Modo Discreto:** Armazenamento 100% local via `localStorage` (sem criação de conta), bloqueio por PIN de 4 dígitos, modo discreto na interface e backup portátil criptografado ponta a ponta com **AES-GCM**.
- **UX Inclusiva e Onboarding por Objetivo:** Linguagem neutra e inclusiva, com modos selecionáveis (*Conhecer meu corpo*, *Acompanhar libido/bem-estar*, *Evitar gravidez* ou *Tentar engravidar*).

---

## 🛡️ Privacidade e Segurança

Dados sobre saúde menstrual, fertilidade e vida sexual são altamente sensíveis. A **Maré** foi projetada para rodar sem dependências de backend proprietário:

- **Dados apenas no dispositivo:** Os registros ficam salvos no `localStorage` do navegador, sem envio automático para servidores externos.
- **Zero rastreamento comercial:** Não há venda, compartilhamento ou monetização de dados íntimos com terceiros.
- **Backup sob seu controle:** Caso deseje migrar de aparelho ou guardar uma cópia de segurança, você pode exportar e restaurar um arquivo `.mare` criptografado localmente com senha (`PBKDF2` + `AES-GCM`).

---

## 🚀 Como rodar o projeto localmente e publicar

A aplicação é composta por arquivos estáticos na raiz do repositório (`index.html`, `manifest.json` e `sw.js`), sem necessidade de `npm install` ou etapa de build.

### Rodar localmente

1. Clone o repositório:
   ```bash
   git clone [https://github.com/gabrieloest/mare-app.git](https://github.com/gabrieloest/mare-app.git)
   cd mare-app
