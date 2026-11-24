# Node PRO course

## AWS

смуга: запасна (LocalStack)

HW-31: [інструкція, обмеження та докази](marketplace/README.md#aws).
Робочий каталог — `marketplace/`; Pulumi-програми — `marketplace/infra/base/`
і `marketplace/infra/demo/`, докази — `marketplace/evidence/hw31/`.
AWS-акаунт, картка та платна підписка LocalStack не потрібні.

```bash
cd marketplace
npm ci --prefix infra/base
npm ci --prefix infra/demo
SKIP_VAULT=1 npm run hw31:verify
SKIP_VAULT=1 npm run hw31:stop
```

teardown-run: локальний; workflow `.github/workflows/teardown.yml` підготовлений,
але GitHub Actions ще не запускався. Посилання на прогін не вигадане.
