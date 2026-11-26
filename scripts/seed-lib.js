/* 把语料库 JSON 转成可在 Supabase SQL Editor 里分段运行的 SQL。
   浏览器工具和命令行脚本共用这一份。文件本身不含单词。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SeedLib = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function sqlString(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
  }

  function sqlText(value) {
    if (value === null || value === undefined || value === '') return 'null';
    return sqlString(value);
  }

  function banner(name, text) {
    return (
      '-- ' + name + '\n' +
      '-- ' + text + '\n' +
      '-- 在 Supabase → SQL Editor → New query 中整段粘贴并 Run。\n' +
      '-- 可以重复运行。不要把这个文件上传到 GitHub，也不要发给买家。\n\n'
    );
  }

  function buildSeed(corpus, options) {
    if (!corpus || !Array.isArray(corpus.pages)) {
      throw new Error('JSON 格式不对：缺少 pages 数组。请选择语料库 JSON 文件。');
    }
    var chunkSize = (options && options.chunkSize) || 800;
    if (chunkSize < 1) throw new Error('chunkSize 不正确');

    var seen = Object.create(null);
    var videos = [];
    var items = [];
    for (var p = 0; p < corpus.pages.length; p++) {
      var page = corpus.pages[p];
      if (!Number.isInteger(page.page) || page.page <= 0) {
        throw new Error('视频编号不正确');
      }
      if (!page.title || !page.url) throw new Error('视频缺少 title 或 url：P' + page.page);
      if (!Array.isArray(page.items)) throw new Error('视频缺少 items：P' + page.page);
      videos.push(page);
      for (var i = 0; i < page.items.length; i++) {
        var item = page.items[i];
        if (!item.id || item.en == null || item.t == null || item.t === '') {
          throw new Error('单词缺少 id、en 或 t（P' + page.page + '）');
        }
        var id = String(item.id);
        if (seen[id]) throw new Error('重复的单词 id：' + id);
        seen[id] = true;
        var prefix = 'P' + page.page + '-';
        if (id.indexOf(prefix) !== 0) throw new Error('单词 id 和视频编号不一致：' + id);
        var seconds = Math.round(Number(item.t));
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error('时间不正确：' + id);
        items.push({
          id: id,
          page: page.page,
          en: String(item.en),
          zh: item.zh == null || item.zh === '' ? null : String(item.zh),
          t: seconds,
        });
      }
    }

    videos.sort(function (a, b) { return a.page - b.page; });
    items.sort(function (a, b) {
      if (a.page !== b.page) return a.page - b.page;
      if (a.t !== b.t) return a.t - b.t;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    var files = [];
    var videoValues = videos.map(function (page) {
      var cid = page.cid == null || page.cid === '' ? 'null' : String(Math.round(Number(page.cid)));
      var dur = page.duration_s == null || page.duration_s === '' ? 'null' : String(Math.round(Number(page.duration_s)));
      return '(' + page.page + ', ' + sqlString(page.title) + ', ' + cid + ', ' + dur + ', ' + sqlString(page.url) + ')';
    }).join(',\n');

    files.push({
      name: '00_videos.sql',
      title: '视频列表（' + videos.length + ' 集）',
      sql: banner('00_videos.sql', '视频列表，共 ' + videos.length + ' 集。请第一个运行。') +
        'insert into public.videos (page, title, cid, duration_s, url) values\n' +
        videoValues + '\n' +
        'on conflict (page) do update set\n' +
        '  title = excluded.title,\n' +
        '  cid = excluded.cid,\n' +
        '  duration_s = excluded.duration_s,\n' +
        '  url = excluded.url;\n',
    });

    var chunks = Math.max(1, Math.ceil(items.length / chunkSize));
    for (var c = 0; c < chunks; c++) {
      var slice = items.slice(c * chunkSize, (c + 1) * chunkSize);
      var name = '01_items_' + String(c + 1).padStart(2, '0') + '.sql';
      var values = slice.map(function (it) {
        return '(' + sqlString(it.id) + ', ' + it.page + ', ' + sqlString(it.en) + ', ' + sqlText(it.zh) + ', ' + it.t + ')';
      }).join(',\n');
      files.push({
        name: name,
        title: '单词 第 ' + (c + 1) + '/' + chunks + ' 段（' + slice.length + ' 个）',
        sql: banner(name, '单词第 ' + (c + 1) + '/' + chunks + ' 段，本段 ' + slice.length + ' 个。按文件名顺序运行。') +
          'insert into public.items (id, page, en, zh, t) values\n' +
          values + '\n' +
          'on conflict (id) do nothing;\n',
      });
    }

    files.push({
      name: '99_check.sql',
      title: '检查导入结果',
      sql: banner('99_check.sql', '最后运行。结果应是 videos = ' + videos.length + ' ，items = ' + items.length + ' 。') +
        'select\n' +
        '  (select count(*)::int from public.videos) as videos,\n' +
        '  (select count(*)::int from public.items) as items;\n',
    });

    return { videoCount: videos.length, itemCount: items.length, files: files };
  }

  return { buildSeed: buildSeed };
});
