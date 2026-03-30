---
title: Changelog
---

<script setup>
import { data as releases } from './.vitepress/data/releases.data'

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
</script>

# Changelog

<template v-for="release in releases" :key="release.tag">

## {{ release.name || release.tag }}

<span style="color: var(--vp-c-text-2); font-size: 0.9em;">{{ formatDate(release.date) }}</span>
<span v-if="release.prerelease" style="margin-left: 8px; padding: 2px 8px; background: var(--vp-c-yellow-soft); color: var(--vp-c-yellow-1); border-radius: 4px; font-size: 0.8em;">pre-release</span>

<div v-html="release.body" />

---

</template>
