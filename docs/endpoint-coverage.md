# Endpoint Coverage

OpenTabl ne doit pas valider un déploiement si le frontend appelle une route API absente du Worker.

## Commande

```bash
npm run audit:endpoints
```

La commande :

- scanne `frontend/modules` pour trouver les appels `$client.get/post/patch/put/delete`;
- scanne `src/routes` et `src/index.ts` pour trouver les routes Hono exposées;
- normalise les paramètres dynamiques comme `${id}`, `:id` et les slashs finaux;
- écrit le rapport complet dans `reports/endpoint-audit.json`;
- échoue avec un code non zéro si un endpoint appelé par l'UI manque côté Worker;
- échoue aussi si du code source backend contient un marqueur `not implemented`.

## Validation avant déploiement

```bash
npm run check
```

`npm run check` lance le typecheck puis l'audit endpoints. Le résultat attendu avant déploiement est :

```text
missing endpoints: 0
not implemented markers in src: 0
```

Tant que ce résultat n'est pas atteint, l'application n'est pas considérée comme couverte.

## Rapport actuel

Le rapport généré est dans `reports/endpoint-audit.json`. Les endpoints listés dans `missing` sont les routes appelées par l'interface mais non exposées par le Worker.
